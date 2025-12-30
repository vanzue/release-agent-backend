import pino from 'pino';
import type { Db } from './store.js';
import {
  setJob,
  setSessionStatus,
  upsertArtifact,
  setSessionStats,
  loadSession,
  getArtifact,
  setCommitSummaryStatus,
} from './store.js';
import { compareCommits, getPullRequest, listPullRequestFiles, listPullsForCommit, getCommit, getCommitDiff } from './github.js';
import { buildChangesArtifact } from './changes.js';
import { commitToReleaseNoteText, formatReleaseNote } from './releaseNotes.js';
import { upsertCommitSummary, getCommitSummaries } from './commitSummaries.js';
import { getReleaseNotesAgent, getAnalysisAgent, getTestPlanAgent, type ChangeInput, type Hotspot, type CommitInput } from './agents/index.js';
import type { RegenerateReleaseNoteRequest } from '@release-agent/contracts';

const logger = pino({
  name: 'session-runner',
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SessionContext {
  db: Db;
  sessionId: string;
  repoFullName: string;
  baseRef: string;
  headRef: string;
  // Populated by runParseChanges, reused by later jobs
  commits: any[];
  commitToPr: Map<string, PrDetails>;
}

interface PrDetails {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  additions: number;
  deletions: number;
  filesChanged: number;
}

interface ReleaseNoteResult {
  sha: string;
  summaryText: string;
  area: string;
}

type ChangesArtifact = { sessionId: string; items: any[] };
type HotspotsArtifact = { sessionId: string; items: Hotspot[] };
type ReleaseNotesArtifact = { sessionId: string; sections: any[] };
type TestPlanArtifact = { sessionId: string; sections: any[] };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function isMergeCommit(message: string): boolean {
  const subject = (message ?? '').split('\n')[0]?.trim() ?? '';
  return /^merge\b/i.test(subject);
}

function toChangeInputs(items: any[]): ChangeInput[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    number: item.number,
    author: item.author,
    area: item.area,
    type: item.type,
    risk: item.risk,
    filesChanged: item.filesChanged,
    additions: item.additions,
    deletions: item.deletions,
    signals: item.signals || [],
  }));
}

function toHotspots(items: any[]): Hotspot[] {
  return items.map((h) => ({
    area: h.area,
    score: h.score,
    drivers: h.drivers,
    contributingPrs: h.contributingPrs,
  }));
}

async function failJob(ctx: SessionContext, job: string, error: string, skipNext?: string) {
  await setJob(ctx.db, ctx.sessionId, job, 'failed', 0, error);
  if (skipNext) {
    await setJob(ctx.db, ctx.sessionId, skipNext, 'skipped', 0, 'Previous step failed');
  }
  await setSessionStatus(ctx.db, ctx.sessionId, 'failed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 1: Parse Changes
// ─────────────────────────────────────────────────────────────────────────────

async function runParseChanges(ctx: SessionContext): Promise<ChangesArtifact> {
  const { db, sessionId, repoFullName, baseRef, headRef } = ctx;

  // Always fetch commits (needed for generate-notes even if changes are cached)
  logger.info({ sessionId, repoFullName, baseRef, headRef }, 'Comparing commits');
  const compare = await compareCommits(repoFullName, baseRef, headRef);
  ctx.commits = compare.filter((c) => !isMergeCommit(c.commit.message));
  logger.info({ sessionId, total: compare.length, filtered: ctx.commits.length }, 'Commits fetched');

  // Check cache
  const existing = await getArtifact(db, sessionId, 'changes');
  if (existing?.items?.length > 0) {
    logger.info({ sessionId, itemCount: existing.items.length }, 'Skipping parse-changes (cached)');
    await setJob(db, sessionId, 'parse-changes', 'completed', 100);
    // Still need to fetch PR details for generate-notes
    ctx.commitToPr = await fetchCommitPrDetails(repoFullName, ctx.commits);
    return existing;
  }

  await setJob(db, sessionId, 'parse-changes', 'running', 5);

  // Find PRs for commits and fetch details
  ctx.commitToPr = await fetchCommitPrDetails(repoFullName, ctx.commits);

  // Fetch PR files for changes artifact
  const prNumbers = [...new Set([...ctx.commitToPr.values()].map(p => p.number))];
  const prsWithFiles = await Promise.all(
    prNumbers.sort((a, b) => b - a).map(async (prNumber) => {
      const pr = await getPullRequest(repoFullName, prNumber);
      const files = await listPullRequestFiles(repoFullName, prNumber);
      return { pr, files };
    })
  );

  const artifact = buildChangesArtifact(sessionId, prsWithFiles);
  await upsertArtifact(db, sessionId, 'changes', artifact);
  await setSessionStats(db, sessionId, { changeCount: artifact.items.length });
  await setJob(db, sessionId, 'parse-changes', 'completed', 100);

  return artifact;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 2: Generate Release Notes
// ─────────────────────────────────────────────────────────────────────────────

async function runGenerateNotes(ctx: SessionContext, changesArtifact: ChangesArtifact): Promise<ReleaseNotesArtifact> {
  const { db, sessionId, repoFullName, commits, commitToPr } = ctx;

  const existing = await getArtifact(db, sessionId, 'release-notes');
  if (existing?.sections?.some((s: any) => s.items?.length > 0)) {
    logger.info({ sessionId }, 'Skipping generate-notes (cached)');
    await setJob(db, sessionId, 'generate-notes', 'completed', 100);
    return existing;
  }

  await setJob(db, sessionId, 'generate-notes', 'running', 5);

  // Build PR -> area mapping from Changes
  const prToArea = new Map<number, string>();
  for (const item of changesArtifact.items ?? []) {
    if (item.number && item.area) prToArea.set(item.number, item.area);
  }

  // Use commits from context (already fetched in runParseChanges)
  const existingSummaries = await getCommitSummaries(db, repoFullName, commits.map((c) => c.sha));

  // Split into cached vs. to-process (commitToPr already in context)
  const { cached, toProcess } = splitCommits(commits, existingSummaries, commitToPr, prToArea);

  // Fetch diffs for small changes
  await enrichWithDiffs(repoFullName, toProcess);

  // Generate summaries
  const newResults = await generateSummaries(ctx, toProcess, commitToPr, prToArea);

  // Build artifact
  const allResults = [...cached, ...newResults];
  const artifact = buildReleaseNotesArtifact(sessionId, allResults);

  await upsertArtifact(db, sessionId, 'release-notes', artifact);
  await setSessionStats(db, sessionId, { releaseNotesCount: allResults.length });
  await setJob(db, sessionId, 'generate-notes', 'completed', 100);

  return artifact;
}

async function fetchCommitPrDetails(repoFullName: string, commits: any[]): Promise<Map<string, PrDetails>> {
  const map = new Map<string, PrDetails>();
  await Promise.all(
    commits.map(async (c) => {
      try {
        const pulls = await listPullsForCommit(repoFullName, c.sha);
        if (!pulls?.[0]?.number) return;
        const pr = await getPullRequest(repoFullName, pulls[0].number);
        map.set(c.sha, {
          number: pr.number,
          title: pr.title,
          body: pr.body,
          labels: pr.labels.map((l) => l.name),
          additions: pr.additions,
          deletions: pr.deletions,
          filesChanged: pr.changed_files,
        });
      } catch { /* ignore */ }
    })
  );
  return map;
}

function splitCommits(
  commits: any[],
  existingSummaries: Map<string, any>,
  commitToPr: Map<string, PrDetails>,
  prToArea: Map<number, string>
): { cached: ReleaseNoteResult[]; toProcess: CommitInput[] } {
  const cached: ReleaseNoteResult[] = [];
  const toProcess: CommitInput[] = [];

  for (const c of commits) {
    const existing = existingSummaries.get(c.sha);
    if (existing) {
      const area = existing.prNumber ? prToArea.get(existing.prNumber) ?? 'General' : 'General';
      cached.push({ sha: c.sha, summaryText: existing.summaryText, area });
    } else {
      const pr = commitToPr.get(c.sha);
      const input: CommitInput = {
        sha: c.sha,
        message: c.commit.message,
        author: c.author?.login ?? null,
      };
      if (pr) {
        input.prNumber = pr.number;
        input.prTitle = pr.title;
        input.prDescription = pr.body ?? undefined;
        input.prLabels = pr.labels;
        input.filesChanged = pr.filesChanged;
        input.additions = pr.additions;
        input.deletions = pr.deletions;
      }
      toProcess.push(input);
    }
  }

  return { cached, toProcess };
}

async function enrichWithDiffs(repoFullName: string, commits: CommitInput[]) {
  const SMALL_FILES = 10;
  const SMALL_LINES = 500;

  await Promise.all(
    commits.map(async (c) => {
      const isSmall = (c.filesChanged ?? 0) <= SMALL_FILES &&
                      ((c.additions ?? 0) + (c.deletions ?? 0)) <= SMALL_LINES;
      const hasDesc = c.prDescription && c.prDescription.length > 50;
      if (isSmall && !hasDesc) {
        try { c.diff = await getCommitDiff(repoFullName, c.sha); } catch { /* ignore */ }
      }
    })
  );
}

async function generateSummaries(
  ctx: SessionContext,
  toProcess: CommitInput[],
  commitToPr: Map<string, PrDetails>,
  prToArea: Map<number, string>
): Promise<ReleaseNoteResult[]> {
  if (toProcess.length === 0) return [];

  const { db, sessionId, repoFullName, commits } = ctx;
  const agent = getReleaseNotesAgent();

  if (!agent) {
    logger.warn({ sessionId }, 'LLM not configured, using fallback');
    return generateFallbackSummaries(ctx, toProcess, commitToPr, prToArea);
  }

  try {
    logger.info({ sessionId, count: toProcess.length }, 'Generating with LLM');
    const batch = await agent.summarizeCommitsBatch(toProcess);
    const results: ReleaseNoteResult[] = [];

    for (const summary of batch.summaries) {
      const commit = commits.find((c) => c.sha.startsWith(summary.commitSha));
      const fullSha = commit?.sha ?? summary.commitSha;
      const prDetails = commitToPr.get(fullSha);
      const prNumber = prDetails?.number ?? null;
      const creditedLogin = commit?.author?.login ?? null;

      const formattedText = formatReleaseNote(summary.summary, {
        creditedLogin,
        prNumber,
        repoFullName,
      });

      await upsertCommitSummary(db, {
        repoFullName,
        commitSha: fullSha,
        summaryText: formattedText,
        creditedLogin,
        prNumber,
      });

      const area = (prNumber ? prToArea.get(prNumber) : null) ?? summary.area ?? 'General';
      results.push({ sha: fullSha, summaryText: formattedText, area });
    }

    logger.info({ sessionId, generated: results.length }, 'LLM generation complete');
    return results;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, sessionId }, 'LLM generation failed');
    await failJob(ctx, 'generate-notes', msg);
    throw new Error(`LLM release notes generation failed: ${msg}`);
  }
}

async function generateFallbackSummaries(
  ctx: SessionContext,
  toProcess: CommitInput[],
  commitToPr: Map<string, PrDetails>,
  prToArea: Map<number, string>
): Promise<ReleaseNoteResult[]> {
  const { db, repoFullName } = ctx;
  const results: ReleaseNoteResult[] = [];

  for (const c of toProcess) {
    const text = commitToReleaseNoteText(c.message, c.author);
    if (!text) continue;

    const prNumber = commitToPr.get(c.sha)?.number ?? null;
    await upsertCommitSummary(db, {
      repoFullName,
      commitSha: c.sha,
      summaryText: text,
      creditedLogin: c.author,
      prNumber,
    });

    const area = (prNumber ? prToArea.get(prNumber) : null) ?? 'General';
    results.push({ sha: c.sha, summaryText: text, area });
  }

  return results;
}

function buildReleaseNotesArtifact(sessionId: string, results: ReleaseNoteResult[]): ReleaseNotesArtifact {
  const byArea = new Map<string, any[]>();
  for (const r of results) {
    const items = byArea.get(r.area) || [];
    items.push({
      id: r.sha,
      text: r.summaryText,
      source: { kind: 'commit', ref: r.sha },
      excluded: false,
    });
    byArea.set(r.area, items);
  }

  const sections = [...byArea.entries()]
    .sort(([a], [b]) => {
      if (a === 'General') return 1;
      if (b === 'General') return -1;
      return a.localeCompare(b);
    })
    .map(([area, items]) => ({ area, items }));

  return { sessionId, sections };
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 3: Analyze Hotspots
// ─────────────────────────────────────────────────────────────────────────────

async function runAnalyzeHotspots(ctx: SessionContext, changesArtifact: ChangesArtifact): Promise<HotspotsArtifact> {
  const { db, sessionId } = ctx;

  const existing = await getArtifact(db, sessionId, 'hotspots');
  if (existing?.items?.length > 0) {
    logger.info({ sessionId }, 'Skipping analyze-hotspots (cached)');
    await setJob(db, sessionId, 'analyze-hotspots', 'completed', 100);
    return existing;
  }

  await setJob(db, sessionId, 'analyze-hotspots', 'running', 5);

  const agent = getAnalysisAgent();
  if (!agent) {
    logger.error({ sessionId }, 'LLM not configured for analysis');
    await failJob(ctx, 'analyze-hotspots', 'LLM not configured', 'generate-testplan');
    throw new Error('LLM not configured for analysis');
  }

  if (!changesArtifact.items?.length) {
    const artifact: HotspotsArtifact = { sessionId, items: [] };
    await upsertArtifact(db, sessionId, 'hotspots', artifact);
    await setJob(db, sessionId, 'analyze-hotspots', 'completed', 100);
    return artifact;
  }

  try {
    logger.info({ sessionId, changeCount: changesArtifact.items.length }, 'Analyzing hotspots');
    const analysis = await agent.analyzeChanges(toChangeInputs(changesArtifact.items));

    const artifact: HotspotsArtifact = {
      sessionId,
      items: analysis.hotspots.map((h, idx) => ({
        id: `hotspot-${idx + 1}`,
        rank: idx + 1,
        area: h.area,
        score: h.score,
        drivers: h.drivers,
        contributingPrs: h.contributingPrs,
      })),
    };

    await upsertArtifact(db, sessionId, 'hotspots', artifact);
    await setJob(db, sessionId, 'analyze-hotspots', 'completed', 100);
    logger.info({ sessionId, hotspotCount: artifact.items.length }, 'Analysis complete');

    return artifact;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, sessionId }, 'Analysis failed');
    await failJob(ctx, 'analyze-hotspots', msg, 'generate-testplan');
    throw new Error(`LLM analysis failed: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 4: Generate Test Plan
// ─────────────────────────────────────────────────────────────────────────────

async function runGenerateTestPlan(
  ctx: SessionContext,
  changesArtifact: ChangesArtifact,
  hotspotsArtifact: HotspotsArtifact
): Promise<TestPlanArtifact> {
  const { db, sessionId } = ctx;

  const existing = await getArtifact(db, sessionId, 'test-plan');
  if (existing?.sections?.some((s: any) => s.cases?.length > 0)) {
    logger.info({ sessionId }, 'Skipping generate-testplan (cached)');
    await setJob(db, sessionId, 'generate-testplan', 'completed', 100);
    return existing;
  }

  await setJob(db, sessionId, 'generate-testplan', 'running', 5);

  const agent = getTestPlanAgent();
  if (!agent) {
    logger.error({ sessionId }, 'LLM not configured for test plan');
    await failJob(ctx, 'generate-testplan', 'LLM not configured');
    throw new Error('LLM not configured for test plan generation');
  }

  if (!changesArtifact.items?.length) {
    const artifact: TestPlanArtifact = { sessionId, sections: [] };
    await upsertArtifact(db, sessionId, 'test-plan', artifact);
    await setJob(db, sessionId, 'generate-testplan', 'completed', 100);
    return artifact;
  }

  try {
    const changeInputs = toChangeInputs(changesArtifact.items);
    const hotspots = toHotspots(hotspotsArtifact.items ?? []);

    logger.info({ sessionId, changeCount: changeInputs.length }, 'Generating test plan');
    const testPlan = await agent.generateTestPlan(changeInputs, hotspots);

    const artifact: TestPlanArtifact = {
      sessionId,
      sections: testPlan.sections.map((s) => ({
        area: s.area,
        cases: s.cases.map((c) => ({
          id: c.id,
          text: c.text,
          checked: false,
          priority: c.priority,
          source: c.source,
        })),
      })),
    };

    await upsertArtifact(db, sessionId, 'test-plan', artifact);
    await setJob(db, sessionId, 'generate-testplan', 'completed', 100);
    logger.info({ sessionId, sections: artifact.sections.length }, 'Test plan complete');

    return artifact;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, sessionId }, 'Test plan generation failed');
    await failJob(ctx, 'generate-testplan', msg);
    throw new Error(`LLM test plan generation failed: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export async function runSession(db: Db, sessionId: string) {
  logger.info({ sessionId }, 'Session started');

  const loaded = await loadSession(db, sessionId);
  if (!loaded) throw new Error('Session not found');

  const ctx: SessionContext = {
    db,
    sessionId,
    repoFullName: loaded.repoFullName,
    baseRef: loaded.baseRef,
    headRef: loaded.headRef,
    commits: [],
    commitToPr: new Map(),
  };

  await setSessionStatus(db, sessionId, 'generating');

  const changesArtifact = await runParseChanges(ctx);
  await runGenerateNotes(ctx, changesArtifact);
  const hotspotsArtifact = await runAnalyzeHotspots(ctx, changesArtifact);
  await runGenerateTestPlan(ctx, changesArtifact, hotspotsArtifact);

  await setSessionStatus(db, sessionId, 'ready');
  logger.info({ sessionId }, 'Session completed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Regenerate Single Item
// ─────────────────────────────────────────────────────────────────────────────

export async function regenerateCommitSummary(db: Db, request: RegenerateReleaseNoteRequest) {
  const { sessionId, itemId, commitSha, repoFullName } = request;
  logger.info({ sessionId, itemId, commitSha }, 'Regenerating commit summary');

  try {
    const commit = await getCommit(repoFullName, commitSha);
    if (!commit) throw new Error(`Commit ${commitSha} not found`);

    const { creditedLogin, prNumber, prDetails } = await fetchPrForCommit(repoFullName, commitSha, commit);
    const artifact = await getArtifact(db, sessionId, 'release-notes');
    const currentText = findItemText(artifact, itemId);

    const summaryText = await generateSingleSummary(
      repoFullName, commitSha, commit, prDetails, currentText, creditedLogin, prNumber
    );

    await upsertCommitSummary(db, { repoFullName, commitSha, summaryText, creditedLogin, prNumber });
    await updateArtifactItem(db, sessionId, artifact, itemId, summaryText);
    await setCommitSummaryStatus(db, repoFullName, commitSha, 'ready');

    logger.info({ sessionId, itemId, commitSha }, 'Regeneration completed');
  } catch (error) {
    logger.error({ err: error, sessionId, itemId, commitSha }, 'Regeneration failed');
    await setCommitSummaryStatus(db, repoFullName, commitSha, 'ready');
    await markArtifactItemReady(db, sessionId, itemId);
    throw error;
  }
}

async function fetchPrForCommit(
  repoFullName: string,
  commitSha: string,
  commit: any
): Promise<{ creditedLogin: string | null; prNumber: number | null; prDetails: PrDetails | null }> {
  let creditedLogin = commit.author?.login ?? null;
  let prNumber: number | null = null;
  let prDetails: PrDetails | null = null;

  try {
    const pulls = await listPullsForCommit(repoFullName, commitSha);
    if (pulls?.[0]?.number) {
      const pr = await getPullRequest(repoFullName, pulls[0].number);
      creditedLogin = pr.user?.login ?? creditedLogin;
      prNumber = pr.number;
      prDetails = {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        labels: pr.labels.map((l) => l.name),
        additions: pr.additions,
        deletions: pr.deletions,
        filesChanged: pr.changed_files,
      };
    }
  } catch { /* ignore */ }

  return { creditedLogin, prNumber, prDetails };
}

function findItemText(artifact: any, itemId: string): string {
  for (const section of artifact?.sections ?? []) {
    const item = section.items?.find((i: any) => i.id === itemId);
    if (item) return item.text;
  }
  return '';
}

async function generateSingleSummary(
  repoFullName: string,
  commitSha: string,
  commit: any,
  prDetails: PrDetails | null,
  currentText: string,
  creditedLogin: string | null,
  prNumber: number | null
): Promise<string> {
  const agent = getReleaseNotesAgent();
  if (!agent) {
    return commitToReleaseNoteText(commit.commit.message, creditedLogin) || currentText;
  }

  try {
    let diff: string | undefined;
    try { diff = await getCommitDiff(repoFullName, commitSha); } catch { /* ignore */ }

    const input: CommitInput = {
      sha: commitSha,
      message: commit.commit.message,
      author: creditedLogin,
      diff,
    };

    if (prDetails) {
      input.prNumber = prDetails.number;
      input.prTitle = prDetails.title;
      input.prDescription = prDetails.body ?? undefined;
      input.prLabels = prDetails.labels;
      input.filesChanged = prDetails.filesChanged;
      input.additions = prDetails.additions;
      input.deletions = prDetails.deletions;
    }

    const result = await agent.regenerate(currentText, input);
    return formatReleaseNote(result.summary, { creditedLogin, prNumber, repoFullName });
  } catch (error) {
    logger.warn({ err: error, commitSha }, 'LLM regeneration failed, using fallback');
    return commitToReleaseNoteText(commit.commit.message, creditedLogin) || currentText;
  }
}

async function updateArtifactItem(db: Db, sessionId: string, artifact: any, itemId: string, text: string) {
  if (!artifact) return;
  for (const section of artifact.sections ?? []) {
    const item = section.items?.find((i: any) => i.id === itemId);
    if (item) {
      item.text = text;
      item.status = 'ready';
      break;
    }
  }
  await upsertArtifact(db, sessionId, 'release-notes', artifact);
}

async function markArtifactItemReady(db: Db, sessionId: string, itemId: string) {
  const artifact = await getArtifact(db, sessionId, 'release-notes');
  if (!artifact) return;
  for (const section of artifact.sections ?? []) {
    const item = section.items?.find((i: any) => i.id === itemId);
    if (item) {
      item.status = 'ready';
      break;
    }
  }
  await upsertArtifact(db, sessionId, 'release-notes', artifact);
}

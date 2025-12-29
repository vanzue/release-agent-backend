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

/**
 * Check if a commit message is from a merge commit.
 */
export function isMergeCommit(message: string): boolean {
  const subject = (message ?? '').split('\n')[0]?.trim() ?? '';
  return /^merge\b/i.test(subject);
}

/**
 * Run a full session: parse-changes, generate-notes, analyze-hotspots, generate-testplan.
 */
export async function runSession(db: Db, sessionId: string) {
  logger.info({ sessionId }, 'runSession started');

  const loaded = await loadSession(db, sessionId);
  if (!loaded) {
    throw new Error('Session not found');
  }

  const { session, repoFullName, baseRef, headRef } = loaded;
  await setSessionStatus(db, sessionId, 'generating');

  // Check existing artifacts to skip completed jobs
  const existingChanges = await getArtifact(db, sessionId, 'changes');
  const existingReleaseNotes = await getArtifact(db, sessionId, 'release-notes');

  // Job: parse-changes - PR-based view of the range
  if (existingChanges && existingChanges.items?.length > 0) {
    logger.info({ sessionId, itemCount: existingChanges.items.length }, 'Skipping parse-changes (cached)');
    await setJob(db, sessionId, 'parse-changes', 'completed', 100);
  } else {
    await setJob(db, sessionId, 'parse-changes', 'running', 5);

    logger.info({ sessionId, repoFullName, baseRef, headRef }, 'Comparing commits');
    const compare = await compareCommits(repoFullName, baseRef, headRef);
    logger.info({ sessionId, totalCommits: compare.length }, 'Compare result');
    const commits = compare.filter((c) => !isMergeCommit(c.commit.message));
    logger.info({ sessionId, filteredCommits: commits.length, shas: commits.map(c => c.sha.slice(0, 7)) }, 'After filtering merge commits');

    const prByNumber = new Map<number, { number: number; creditedLogin: string | null }>();
    await Promise.all(
      commits.map(async (c) => {
        try {
          const pulls = await listPullsForCommit(repoFullName, c.sha);
          const pr = pulls?.[0];
          if (pr?.number) {
            prByNumber.set(pr.number, { number: pr.number, creditedLogin: pr.user?.login ?? null });
          }
        } catch {
          // ignore
        }
      })
    );

    const prNumbers = [...prByNumber.keys()].sort((a, b) => b - a);
    const prsWithFiles = await Promise.all(
      prNumbers.map(async (prNumber) => {
        const pr = await getPullRequest(repoFullName, prNumber);
        const files = await listPullRequestFiles(repoFullName, prNumber);
        return { pr, files };
      })
    );

    const changesArtifact = buildChangesArtifact(sessionId, prsWithFiles);
    await upsertArtifact(db, sessionId, 'changes', changesArtifact);
    await setSessionStats(db, sessionId, { changeCount: changesArtifact.items.length });
    await setJob(db, sessionId, 'parse-changes', 'completed', 100);
  }

  // Job: generate-notes - use ReleaseNotesAgent for LLM-powered summaries
  if (existingReleaseNotes && existingReleaseNotes.sections?.some((s: any) => s.items?.length > 0)) {
    logger.info({ sessionId }, 'Skipping generate-notes (cached)');
    await setJob(db, sessionId, 'generate-notes', 'completed', 100);
  } else {
    await setJob(db, sessionId, 'generate-notes', 'running', 5);

    const compare = await compareCommits(repoFullName, baseRef, headRef);
    const commits = compare.filter((c) => !isMergeCommit(c.commit.message));

    // Check for existing summaries to avoid regenerating
    const existingSummaries = await getCommitSummaries(db, repoFullName, commits.map((c) => c.sha));
    logger.info({ sessionId, existing: existingSummaries.size, total: commits.length }, 'Found existing commit summaries');

    // Get PR info for each commit (including full PR details)
    const commitToPrDetails = new Map<string, {
      number: number;
      title: string;
      body: string | null;
      labels: string[];
      additions: number;
      deletions: number;
      filesChanged: number;
    }>();
    
    await Promise.all(
      commits.map(async (c) => {
        try {
          const pulls = await listPullsForCommit(repoFullName, c.sha);
          const prBasic = pulls?.[0];
          if (prBasic?.number) {
            // Fetch full PR details including body/description
            const prFull = await getPullRequest(repoFullName, prBasic.number);
            commitToPrDetails.set(c.sha, {
              number: prFull.number,
              title: prFull.title,
              body: prFull.body,
              labels: prFull.labels.map(l => l.name),
              additions: prFull.additions,
              deletions: prFull.deletions,
              filesChanged: prFull.changed_files,
            });
          }
        } catch {
          // ignore - some commits may not have associated PRs
        }
      })
    );
    
    logger.info({ sessionId, commitsWithPR: commitToPrDetails.size, total: commits.length }, 'Fetched PR details');

    // Get ReleaseNotesAgent for LLM-powered summaries
    const releaseNotesAgent = getReleaseNotesAgent();
    logger.info({ 
      sessionId, 
      llmAvailable: releaseNotesAgent !== null,
      llmProvider: process.env.LLM_PROVIDER ?? 'azure',
      llmModel: process.env.LLM_MODEL ?? 'not-set',
    }, 'LLM client status');
    
    // Separate commits that need LLM processing from cached ones
    const cachedResults: Array<{ sha: string; summaryText: string; area: string }> = [];
    const commitsToProcess: CommitInput[] = [];
    
    for (const c of commits) {
      const cached = existingSummaries.get(c.sha);
      if (cached) {
        cachedResults.push({ sha: c.sha, summaryText: cached.summaryText, area: 'General' });
      } else {
        const prDetails = commitToPrDetails.get(c.sha);
        const commitInput: CommitInput = {
          sha: c.sha,
          message: c.commit.message,
          author: c.author?.login ?? null,
        };
        
        // Add PR context if available
        if (prDetails) {
          commitInput.prNumber = prDetails.number;
          commitInput.prTitle = prDetails.title;
          commitInput.prDescription = prDetails.body ?? undefined;
          commitInput.prLabels = prDetails.labels;
          commitInput.filesChanged = prDetails.filesChanged;
          commitInput.additions = prDetails.additions;
          commitInput.deletions = prDetails.deletions;
        }
        
        commitsToProcess.push(commitInput);
      }
    }

    // For small changes without PR description, fetch diff for better context
    const SMALL_CHANGE_THRESHOLD = 10; // files
    const SMALL_LINES_THRESHOLD = 500; // total lines changed
    
    await Promise.all(
      commitsToProcess.map(async (c) => {
        const isSmallChange = (c.filesChanged ?? 0) <= SMALL_CHANGE_THRESHOLD && 
                             ((c.additions ?? 0) + (c.deletions ?? 0)) <= SMALL_LINES_THRESHOLD;
        const hasDescription = c.prDescription && c.prDescription.length > 50;
        
        // Fetch diff for small changes without good description
        if (isSmallChange && !hasDescription) {
          try {
            const diff = await getCommitDiff(repoFullName, c.sha);
            c.diff = diff;
          } catch {
            // ignore - diff fetch failed
          }
        }
      })
    );
    
    logger.info({ 
      sessionId, 
      toProcess: commitsToProcess.length,
      withDiff: commitsToProcess.filter(c => c.diff).length,
      withPrDescription: commitsToProcess.filter(c => c.prDescription).length,
    }, 'Prepared commits with context for LLM');

    // Process new commits with LLM if available
    let newResults: Array<{ sha: string; summaryText: string; area: string }> = [];
    
    if (commitsToProcess.length > 0) {
      if (releaseNotesAgent) {
        try {
          logger.info({ 
            sessionId, 
            count: commitsToProcess.length,
            sampleCommit: commitsToProcess[0] ? {
              sha: commitsToProcess[0].sha.slice(0, 7),
              hasPrDescription: !!commitsToProcess[0].prDescription,
              hasDiff: !!commitsToProcess[0].diff,
              prLabels: commitsToProcess[0].prLabels,
            } : null,
          }, 'Starting LLM release notes generation');
          
          const batchResult = await releaseNotesAgent.summarizeCommitsBatch(commitsToProcess);
          
          logger.info({ 
            sessionId, 
            summariesReturned: batchResult.summaries.length,
            sampleSummary: batchResult.summaries[0] ? {
              sha: batchResult.summaries[0].commitSha?.slice(0, 7),
              area: batchResult.summaries[0].area,
              type: batchResult.summaries[0].type,
              summaryLength: batchResult.summaries[0].summary?.length,
            } : null,
          }, 'LLM returned batch results');
          
          // Save summaries to database and build results
          for (const summary of batchResult.summaries) {
            // LLM returns short SHA (7 chars), need to match with full SHA using startsWith
            const commit = commits.find(c => c.sha.startsWith(summary.commitSha));
            const fullSha = commit?.sha ?? summary.commitSha; // Use full SHA if found
            const creditedLogin = commit?.author?.login ?? null;
            const prDetails = commitToPrDetails.get(fullSha);
            const prNumber = prDetails?.number ?? null;
            
            // Format the summary with thanks and PR link
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
            
            newResults.push({
              sha: fullSha,
              summaryText: formattedText,
              area: summary.area,
            });
          }
          
          logger.info({ sessionId, generated: newResults.length }, 'LLM release notes generation complete');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : undefined;
          logger.error({ 
            err: error, 
            sessionId, 
            errorMessage,
            errorStack,
            errorName: error instanceof Error ? error.name : 'unknown',
          }, 'LLM release notes generation failed');
          await setJob(db, sessionId, 'generate-notes', 'failed', 0, errorMessage);
          await setSessionStatus(db, sessionId, 'failed');
          throw new Error(`LLM release notes generation failed: ${errorMessage}`);
        }
      } else {
        // Fallback to simple extraction if LLM not available
        logger.warn({ 
          sessionId,
          llmProvider: process.env.LLM_PROVIDER ?? 'not-set',
          llmModel: process.env.LLM_MODEL ?? 'not-set',
          azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT ? 'set' : 'not-set',
          azureApiKey: process.env.AZURE_OPENAI_API_KEY ? 'set' : 'not-set',
        }, 'LLM not configured, using simple commit message extraction - CHECK ENV VARS');
        
        for (const c of commitsToProcess) {
          const commit = commits.find(cm => cm.sha === c.sha);
          const summaryText = commitToReleaseNoteText(c.message, c.author);
          if (!summaryText) continue;

          await upsertCommitSummary(db, {
            repoFullName,
            commitSha: c.sha,
            summaryText,
            creditedLogin: c.author,
            prNumber: commitToPrDetails.get(c.sha)?.number ?? null,
          });

          newResults.push({ sha: c.sha, summaryText, area: 'General' });
        }
      }
    }

    // Combine cached and new results
    const allResults = [...cachedResults, ...newResults];

    // Group items by area
    const itemsByArea = new Map<string, Array<{ id: string; text: string; source: { kind: string; ref: string }; excluded: boolean }>>();
    for (const r of allResults) {
      const item = {
        id: r.sha,
        text: r.summaryText,
        source: { kind: 'commit' as const, ref: r.sha },
        excluded: false,
      };
      const existing = itemsByArea.get(r.area) || [];
      existing.push(item);
      itemsByArea.set(r.area, existing);
    }

    // Convert to sections array, sorted alphabetically with General last
    const sections = [...itemsByArea.entries()]
      .sort(([a], [b]) => {
        if (a === 'General') return 1;
        if (b === 'General') return -1;
        return a.localeCompare(b);
      })
      .map(([area, items]) => ({ area, items }));

    const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
    const artifact = { sessionId, sections };
    await upsertArtifact(db, sessionId, 'release-notes', artifact);
    await setSessionStats(db, sessionId, { releaseNotesCount: totalItems });
    await setJob(db, sessionId, 'generate-notes', 'completed', 100);
  }

  // Job: analyze-hotspots - use AnalysisAgent if available
  const existingHotspots = await getArtifact(db, sessionId, 'hotspots');
  if (existingHotspots && existingHotspots.items?.length > 0) {
    logger.info({ sessionId }, 'Skipping analyze-hotspots (cached)');
    await setJob(db, sessionId, 'analyze-hotspots', 'completed', 100);
  } else {
    await setJob(db, sessionId, 'analyze-hotspots', 'running', 5);
    
    const changesArtifact = await getArtifact(db, sessionId, 'changes');
    const analysisAgent = getAnalysisAgent();
    
    let hotspotsArtifact: { sessionId: string; items: Hotspot[] };
    
    if (analysisAgent && changesArtifact?.items?.length > 0) {
      // Convert to ChangeInput format for the agent
      const changeInputs: ChangeInput[] = changesArtifact.items.map((item: any) => ({
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

      try {
        logger.info({ sessionId, changeCount: changeInputs.length }, 'Running analysis with LLM');
        const analysis = await analysisAgent.analyzeChanges(changeInputs);
        
        // Convert to artifact format with rank
        hotspotsArtifact = {
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
        
        logger.info({ sessionId, hotspotCount: hotspotsArtifact.items.length }, 'LLM analysis complete');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, sessionId }, 'LLM analysis failed');
        await setJob(db, sessionId, 'analyze-hotspots', 'failed', 0, errorMessage);
        await setJob(db, sessionId, 'generate-testplan', 'skipped', 0, 'Previous step failed');
        await setSessionStatus(db, sessionId, 'failed');
        throw new Error(`LLM analysis failed: ${errorMessage}`);
      }
    } else if (!analysisAgent) {
      // No LLM configured - fail the job
      logger.error({ sessionId }, 'LLM not configured for analysis');
      await setJob(db, sessionId, 'analyze-hotspots', 'failed', 0, 'LLM not configured');
      await setJob(db, sessionId, 'generate-testplan', 'skipped', 0, 'Previous step failed');
      await setSessionStatus(db, sessionId, 'failed');
      throw new Error('LLM not configured for analysis');
    } else {
      // No changes to analyze
      hotspotsArtifact = { sessionId, items: [] };
    }
    
    await upsertArtifact(db, sessionId, 'hotspots', hotspotsArtifact);
    await setJob(db, sessionId, 'analyze-hotspots', 'completed', 100);
  }

  // Job: generate-testplan - use TestPlanAgent if available
  const existingTestPlan = await getArtifact(db, sessionId, 'test-plan');
  if (existingTestPlan && existingTestPlan.sections?.some((s: any) => s.cases?.length > 0)) {
    logger.info({ sessionId }, 'Skipping generate-testplan (cached)');
    await setJob(db, sessionId, 'generate-testplan', 'completed', 100);
  } else {
    await setJob(db, sessionId, 'generate-testplan', 'running', 5);
    
    const changesArtifact = await getArtifact(db, sessionId, 'changes');
    const hotspotsArtifact = await getArtifact(db, sessionId, 'hotspots');
    const testPlanAgent = getTestPlanAgent();
    
    let testPlanArtifact: { sessionId: string; sections: any[] };
    
    if (testPlanAgent && changesArtifact?.items?.length > 0) {
      const changeInputs: ChangeInput[] = changesArtifact.items.map((item: any) => ({
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
      
      const hotspots: Hotspot[] = (hotspotsArtifact?.items || []).map((h: any) => ({
        area: h.area,
        score: h.score,
        drivers: h.drivers,
        contributingPrs: h.contributingPrs,
      }));

      try {
        logger.info({ sessionId, changeCount: changeInputs.length }, 'Generating test plan with LLM');
        const testPlan = await testPlanAgent.generateTestPlan(changeInputs, hotspots);
        
        testPlanArtifact = {
          sessionId,
          sections: testPlan.sections.map(s => ({
            area: s.area,
            cases: s.cases.map(c => ({
              id: c.id,
              text: c.text,
              checked: false,
              priority: c.priority,
              source: c.source,
            })),
          })),
        };
        
        logger.info({ 
          sessionId, 
          sectionCount: testPlanArtifact.sections.length,
          totalCases: testPlanArtifact.sections.reduce((sum, s) => sum + s.cases.length, 0),
        }, 'LLM test plan generation complete');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, sessionId }, 'LLM test plan generation failed');
        await setJob(db, sessionId, 'generate-testplan', 'failed', 0, errorMessage);
        await setSessionStatus(db, sessionId, 'failed');
        throw new Error(`LLM test plan generation failed: ${errorMessage}`);
      }
    } else if (!testPlanAgent) {
      // No LLM configured - fail the job
      logger.error({ sessionId }, 'LLM not configured for test plan generation');
      await setJob(db, sessionId, 'generate-testplan', 'failed', 0, 'LLM not configured');
      await setSessionStatus(db, sessionId, 'failed');
      throw new Error('LLM not configured for test plan generation');
    } else {
      // No changes - empty test plan
      testPlanArtifact = { sessionId, sections: [] };
    }
    
    await upsertArtifact(db, sessionId, 'test-plan', testPlanArtifact);
    await setJob(db, sessionId, 'generate-testplan', 'completed', 100);
  }

  await setSessionStatus(db, sessionId, 'ready');
  logger.info({ sessionId }, 'Session completed');
}

/**
 * Regenerate a single commit summary using LLM if available.
 */
export async function regenerateCommitSummary(db: Db, request: RegenerateReleaseNoteRequest) {
  const { sessionId, itemId, commitSha, repoFullName } = request;

  logger.info({ sessionId, itemId, commitSha }, 'Regenerating commit summary');

  try {
    // Fetch the commit to get message and author info
    const commit = await getCommit(repoFullName, commitSha);
    if (!commit) {
      throw new Error(`Commit ${commitSha} not found`);
    }

    // Get PR association and full PR details for context
    let creditedLogin = commit.author?.login ?? null;
    let prNumber: number | null = null;
    let prDetails: {
      number: number;
      title: string;
      body: string | null;
      labels: string[];
      additions: number;
      deletions: number;
      filesChanged: number;
    } | null = null;
    
    try {
      const pulls = await listPullsForCommit(repoFullName, commitSha);
      const prBasic = pulls?.[0];
      if (prBasic?.number) {
        // Fetch full PR details including body/description
        const prFull = await getPullRequest(repoFullName, prBasic.number);
        creditedLogin = prFull.user?.login ?? creditedLogin;
        prNumber = prFull.number;
        prDetails = {
          number: prFull.number,
          title: prFull.title,
          body: prFull.body,
          labels: prFull.labels.map(l => l.name),
          additions: prFull.additions,
          deletions: prFull.deletions,
          filesChanged: prFull.changed_files,
        };
      }
    } catch {
      // Ignore PR lookup failures
    }

    // Get current text for context
    const artifact = await getArtifact(db, sessionId, 'release-notes');
    let currentText = '';
    if (artifact) {
      for (const section of artifact.sections ?? []) {
        const item = (section.items ?? []).find((i: any) => i.id === itemId);
        if (item) {
          currentText = item.text;
          break;
        }
      }
    }

    // Try to use LLM for regeneration
    let summaryText: string;
    const releaseNotesAgent = getReleaseNotesAgent();
    
    if (releaseNotesAgent) {
      try {
        // Try to get the commit diff for better context
        let diff: string | undefined;
        try {
          diff = await getCommitDiff(repoFullName, commitSha);
        } catch {
          // Diff not available, continue without it
        }

        logger.info({ 
          sessionId, 
          commitSha,
          hasPrDetails: !!prDetails,
          hasDiff: !!diff,
        }, 'Regenerating with LLM');
        
        // Build CommitInput with full PR context (same as batch generation)
        const commitInput: CommitInput = {
          sha: commitSha,
          message: commit.commit.message,
          author: creditedLogin,
          diff,
        };
        
        // Add PR context if available
        if (prDetails) {
          commitInput.prNumber = prDetails.number;
          commitInput.prTitle = prDetails.title;
          commitInput.prDescription = prDetails.body ?? undefined;
          commitInput.prLabels = prDetails.labels;
          commitInput.filesChanged = prDetails.filesChanged;
          commitInput.additions = prDetails.additions;
          commitInput.deletions = prDetails.deletions;
        }
        
        const result = await releaseNotesAgent.regenerate(
          currentText,
          commitInput
        );
        
        // Format with thanks and PR link
        summaryText = formatReleaseNote(result.summary, {
          creditedLogin,
          prNumber,
          repoFullName,
        });
      } catch (error) {
        logger.warn({ err: error, sessionId, commitSha }, 'LLM regeneration failed, using fallback');
        summaryText = commitToReleaseNoteText(commit.commit.message, creditedLogin) || currentText;
      }
    } else {
      // Fallback to simple text processing
      summaryText = commitToReleaseNoteText(commit.commit.message, creditedLogin) || currentText;
    }

    if (!summaryText) {
      throw new Error('Failed to generate summary text');
    }

    // Update commit_summaries table
    await upsertCommitSummary(db, {
      repoFullName,
      commitSha,
      summaryText,
      creditedLogin,
      prNumber,
    });

    // Update the release-notes artifact
    if (artifact) {
      for (const section of artifact.sections ?? []) {
        const item = (section.items ?? []).find((i: any) => i.id === itemId);
        if (item) {
          item.text = summaryText;
          item.status = 'ready';
          break;
        }
      }
      await upsertArtifact(db, sessionId, 'release-notes', artifact);
    }

    // Mark as ready
    await setCommitSummaryStatus(db, repoFullName, commitSha, 'ready');

    logger.info({ sessionId, itemId, commitSha }, 'Commit summary regeneration completed');
  } catch (error) {
    logger.error({ err: error, sessionId, itemId, commitSha }, 'Commit summary regeneration failed');

    // Mark as ready even on failure (so user can retry)
    await setCommitSummaryStatus(db, repoFullName, commitSha, 'ready');

    // Update artifact status to ready on failure
    const artifact = await getArtifact(db, sessionId, 'release-notes');
    if (artifact) {
      for (const section of artifact.sections ?? []) {
        const item = (section.items ?? []).find((i: any) => i.id === itemId);
        if (item) {
          item.status = 'ready';
          break;
        }
      }
      await upsertArtifact(db, sessionId, 'release-notes', artifact);
    }

    throw error;
  }
}

import pino from 'pino';
import type { GenerateTestChecklistRequest } from '@release-agent/contracts';
import { getLLMClient } from './llm.js';
import { getArtifact, loadSession, setJob, setSessionStatus, upsertArtifact, type Db } from './store.js';
import {
  DEFAULT_TEST_CHECKLIST_TEMPLATE_URL,
  FALLBACK_TEST_CHECKLIST_TEMPLATE,
  buildChecklistPrompt,
  buildHeuristicChecklist,
} from './prompts/testChecklist.js';
import type { ChangeInput, TestCase } from './agents/types.js';

const logger = pino({
  name: 'test-checklist-runner',
  level: process.env.LOG_LEVEL ?? 'info',
});

type ChecklistStatus = 'queued' | 'running' | 'completed' | 'failed';

type ChecklistItem = {
  id: string;
  prNumber: number;
  area: string;
  title: string;
  status: ChecklistStatus;
  markdown: string | null;
  error: string | null;
  updatedAt: string;
  sourceRefs: string[];
  templateUrl: string | null;
};

type ChecklistState = {
  templateUrl: string | null;
  queuedAt: string | null;
  generatedAt: string | null;
  summary: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
  };
  items: ChecklistItem[];
};

type TestPlanArtifactWithChecklists = {
  sessionId: string;
  sections: any[];
  checklists: ChecklistState;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeChecklists(raw: any): ChecklistState {
  const items: ChecklistItem[] = Array.isArray(raw?.items)
    ? raw.items
        .map((item: any) => {
          if (!item || typeof item.prNumber !== 'number') return null;
          const status = (item.status ?? 'queued') as ChecklistStatus;
          if (status !== 'queued' && status !== 'running' && status !== 'completed' && status !== 'failed') return null;
          return {
            id: typeof item.id === 'string' && item.id.trim() ? item.id : `pr-${item.prNumber}`,
            prNumber: item.prNumber,
            area: typeof item.area === 'string' ? item.area : 'General',
            title: typeof item.title === 'string' ? item.title : `PR #${item.prNumber}`,
            status,
            markdown: typeof item.markdown === 'string' ? item.markdown : null,
            error: typeof item.error === 'string' ? item.error : null,
            updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
            sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs.filter((v: unknown) => typeof v === 'string') : [],
            templateUrl: typeof item.templateUrl === 'string' ? item.templateUrl : null,
          };
        })
        .filter((item: ChecklistItem | null): item is ChecklistItem => Boolean(item))
    : [];

  const summary = {
    total: items.length,
    queued: items.filter((item) => item.status === 'queued').length,
    running: items.filter((item) => item.status === 'running').length,
    completed: items.filter((item) => item.status === 'completed').length,
    failed: items.filter((item) => item.status === 'failed').length,
  };

  const hasDone = summary.completed > 0 || summary.failed > 0;
  return {
    templateUrl: typeof raw?.templateUrl === 'string' ? raw.templateUrl : null,
    queuedAt: typeof raw?.queuedAt === 'string' ? raw.queuedAt : null,
    generatedAt: typeof raw?.generatedAt === 'string' ? raw.generatedAt : (hasDone ? nowIso() : null),
    summary,
    items,
  };
}

function normalizeArtifact(raw: any, sessionId: string): TestPlanArtifactWithChecklists {
  return {
    sessionId: raw?.sessionId ?? sessionId,
    sections: Array.isArray(raw?.sections) ? raw.sections : [],
    checklists: normalizeChecklists(raw?.checklists),
  };
}

function mapChangeInput(raw: any): ChangeInput {
  return {
    id: String(raw?.id ?? `pr-${raw?.number ?? 0}`),
    title: String(raw?.title ?? 'Untitled change'),
    number: Number(raw?.number ?? 0),
    author: String(raw?.author ?? 'unknown'),
    area: String(raw?.area ?? 'General'),
    type: raw?.type === 'New' || raw?.type === 'Fix' || raw?.type === 'Change' ? raw.type : 'Change',
    risk: raw?.risk === 'High' || raw?.risk === 'Medium' || raw?.risk === 'Low' ? raw.risk : 'Medium',
    filesChanged: Number(raw?.filesChanged ?? 0),
    additions: Number(raw?.additions ?? 0),
    deletions: Number(raw?.deletions ?? 0),
    signals: Array.isArray(raw?.signals) ? raw.signals.filter((v: unknown) => typeof v === 'string') : [],
  };
}

function normalizeAreaCases(rawCases: any[]): TestCase[] {
  return rawCases.map((c, idx) => ({
    id: typeof c?.id === 'string' ? c.id : `tc-${idx + 1}`,
    text: typeof c?.text === 'string' ? c.text : (typeof c?.title === 'string' ? c.title : 'Validate behavior'),
    title: typeof c?.title === 'string' ? c.title : (typeof c?.text === 'string' ? c.text : 'Validate behavior'),
    objective: typeof c?.objective === 'string' ? c.objective : (typeof c?.text === 'string' ? c.text : 'Validate behavior'),
    preconditions: Array.isArray(c?.preconditions) ? c.preconditions.filter((v: unknown) => typeof v === 'string') : [],
    steps: Array.isArray(c?.steps) ? c.steps.filter((v: unknown) => typeof v === 'string') : [],
    expected: typeof c?.expected === 'string' ? c.expected : 'Expected behavior is observed.',
    priority: c?.priority === 'Must' || c?.priority === 'Recommended' || c?.priority === 'Exploratory' ? c.priority : 'Recommended',
    type:
      c?.type === 'Functional' ||
      c?.type === 'Regression' ||
      c?.type === 'Negative' ||
      c?.type === 'Integration' ||
      c?.type === 'Security' ||
      c?.type === 'Performance' ||
      c?.type === 'Exploratory'
        ? c.type
        : 'Functional',
    risk: c?.risk === 'High' || c?.risk === 'Medium' || c?.risk === 'Low' ? c.risk : 'Medium',
    source: typeof c?.source === 'string' ? c.source : 'manual',
    sourceRefs: Array.isArray(c?.sourceRefs) ? c.sourceRefs.filter((v: unknown) => typeof v === 'string') : [],
    tags: Array.isArray(c?.tags) ? c.tags.filter((v: unknown) => typeof v === 'string') : [],
  }));
}

async function fetchTemplateMarkdown(templateUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(templateUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Template fetch failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Template is empty');
    }
    return trimmed;
  } finally {
    clearTimeout(timeout);
  }
}

function ensureChecklistItem(
  artifact: TestPlanArtifactWithChecklists,
  change: ChangeInput
): ChecklistItem {
  const now = nowIso();
  const existing = artifact.checklists.items.find((item) => item.prNumber === change.number);
  if (existing) {
    existing.area = change.area;
    existing.title = change.title;
    existing.updatedAt = now;
    existing.sourceRefs = Array.from(new Set([`PR #${change.number}`, `Area: ${change.area}`]));
    return existing;
  }

  const next: ChecklistItem = {
    id: `pr-${change.number}`,
    prNumber: change.number,
    area: change.area,
    title: change.title,
    status: 'queued',
    markdown: null,
    error: null,
    updatedAt: now,
    sourceRefs: [`PR #${change.number}`, `Area: ${change.area}`],
    templateUrl: artifact.checklists.templateUrl,
  };
  artifact.checklists.items.push(next);
  return next;
}

function recomputeSummary(artifact: TestPlanArtifactWithChecklists) {
  const items = artifact.checklists.items;
  artifact.checklists.summary = {
    total: items.length,
    queued: items.filter((item) => item.status === 'queued').length,
    running: items.filter((item) => item.status === 'running').length,
    completed: items.filter((item) => item.status === 'completed').length,
    failed: items.filter((item) => item.status === 'failed').length,
  };

  const noPending = artifact.checklists.summary.queued === 0 && artifact.checklists.summary.running === 0;
  if (noPending && artifact.checklists.summary.total > 0) {
    artifact.checklists.generatedAt = nowIso();
  }
}

async function updateChecklistJobState(db: Db, sessionId: string, checklists: ChecklistState): Promise<void> {
  const { total, queued, running, completed, failed } = checklists.summary;
  const processed = completed + failed;
  const progress = total > 0 ? Math.min(100, Math.max(0, Math.round((processed / total) * 100))) : 100;

  if (queued > 0 || running > 0) {
    await setJob(db, sessionId, 'generate-testchecklists', 'running', Math.max(5, Math.min(95, progress)));
    await setSessionStatus(db, sessionId, 'generating');
    return;
  }

  if (failed > 0) {
    await setJob(
      db,
      sessionId,
      'generate-testchecklists',
      'failed',
      100,
      `${failed} checklist(s) failed out of ${total}.`
    );
    await setSessionStatus(db, sessionId, 'failed');
    return;
  }

  await setJob(db, sessionId, 'generate-testchecklists', 'completed', 100);

  const jobsResult = await db.pool.query(
    `select status from jobs where session_id = $1`,
    [sessionId]
  );
  const statuses = jobsResult.rows.map((row: any) => row.status as string);
  const anyFailed = statuses.some((status) => status === 'failed');
  const hasPendingOrRunning = statuses.some((status) => status === 'pending' || status === 'running');

  if (anyFailed) {
    await setSessionStatus(db, sessionId, 'failed');
  } else if (hasPendingOrRunning) {
    await setSessionStatus(db, sessionId, 'generating');
  } else {
    await setSessionStatus(db, sessionId, 'ready');
  }
}

function normalizeMarkdownOutput(markdown: string, change: ChangeInput): string {
  const trimmed = markdown.trim();
  if (!trimmed) return buildHeuristicChecklist({ change, areaCases: [] }).trim();
  if (/^##\s+/m.test(trimmed)) return trimmed;
  return `## ${change.area} - PR #${change.number}\n${trimmed}`;
}

export async function generateTestChecklistForPr(db: Db, request: GenerateTestChecklistRequest): Promise<void> {
  const session = await loadSession(db, request.sessionId);
  if (!session) {
    logger.warn({ sessionId: request.sessionId, prNumber: request.prNumber }, 'Session not found for checklist generation');
    return;
  }

  const changesArtifact = await getArtifact(db, request.sessionId, 'changes');
  const rawChange = Array.isArray(changesArtifact?.items)
    ? changesArtifact.items.find((item: any) => Number(item?.number) === request.prNumber)
    : null;

  const existingTestPlan = await getArtifact(db, request.sessionId, 'test-plan');
  const artifact = normalizeArtifact(existingTestPlan, request.sessionId);

  if (!rawChange) {
    const fallbackChange: ChangeInput = {
      id: `pr-${request.prNumber}`,
      title: `PR #${request.prNumber}`,
      number: request.prNumber,
      author: 'unknown',
      area: 'General',
      type: 'Change',
      risk: 'Medium',
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      signals: [],
    };
    const entry = ensureChecklistItem(artifact, fallbackChange);
    entry.status = 'failed';
    entry.error = `PR #${request.prNumber} was not found in session changes artifact.`;
    entry.updatedAt = nowIso();
    recomputeSummary(artifact);
    await upsertArtifact(db, request.sessionId, 'test-plan', artifact);
    await updateChecklistJobState(db, request.sessionId, artifact.checklists);
    return;
  }

  const change = mapChangeInput(rawChange);
  const entry = ensureChecklistItem(artifact, change);
  entry.status = 'running';
  entry.error = null;
  entry.updatedAt = nowIso();

  const templateUrl = request.templateUrl?.trim() || artifact.checklists.templateUrl || DEFAULT_TEST_CHECKLIST_TEMPLATE_URL;
  artifact.checklists.templateUrl = templateUrl;
  entry.templateUrl = templateUrl;
  recomputeSummary(artifact);
  await upsertArtifact(db, request.sessionId, 'test-plan', artifact);
  await updateChecklistJobState(db, request.sessionId, artifact.checklists);

  try {
    let templateMarkdown = FALLBACK_TEST_CHECKLIST_TEMPLATE;
    try {
      templateMarkdown = await fetchTemplateMarkdown(templateUrl);
    } catch (templateError) {
      logger.warn(
        { err: templateError, sessionId: request.sessionId, prNumber: request.prNumber, templateUrl },
        'Failed to fetch template; using fallback template'
      );
    }

    const areaCases = normalizeAreaCases(
      (artifact.sections.find((section: any) => section?.area === change.area)?.cases ?? []) as any[]
    );

    const llm = getLLMClient();
    const markdown = llm
      ? await llm.chat({
          messages: [
            {
              role: 'system',
              content:
                'You generate high-quality manual release test checklists. Produce only markdown with checkbox lists and practical executable steps.',
            },
            {
              role: 'user',
              content: buildChecklistPrompt({
                change,
                changedFiles: Array.isArray(rawChange?.files)
                  ? rawChange.files
                      .filter((file: any) => file && typeof file.path === 'string')
                      .map((file: any) => ({
                        path: String(file.path),
                        additions: Number(file.additions ?? 0),
                        deletions: Number(file.deletions ?? 0),
                      }))
                  : [],
                templateMarkdown,
                areaCases,
              }),
            },
          ],
          maxTokens: 2000,
          temperature: 0.25,
        })
      : buildHeuristicChecklist({ change, areaCases });

    entry.status = 'completed';
    entry.markdown = normalizeMarkdownOutput(markdown, change);
    entry.error = null;
    entry.updatedAt = nowIso();
    recomputeSummary(artifact);
    await upsertArtifact(db, request.sessionId, 'test-plan', artifact);
    await updateChecklistJobState(db, request.sessionId, artifact.checklists);
    logger.info({ sessionId: request.sessionId, prNumber: request.prNumber }, 'Generated per-PR test checklist');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    entry.status = 'failed';
    entry.error = message;
    entry.updatedAt = nowIso();
    recomputeSummary(artifact);
    await upsertArtifact(db, request.sessionId, 'test-plan', artifact);
    await updateChecklistJobState(db, request.sessionId, artifact.checklists);
    logger.error({ err: error, sessionId: request.sessionId, prNumber: request.prNumber }, 'Per-PR checklist generation failed');
  }
}

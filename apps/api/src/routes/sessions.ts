import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { PgStore } from '../store/pg.js';
import type { PatchReleaseNotesOp, PatchTestPlanCasePatch, PatchTestPlanOp } from '@release-agent/contracts';
import { cloneJson, ensureSection } from '../utils.js';
import { createSessionRunEnqueuer, createCommitRegenEnqueuer, createTestChecklistEnqueuer } from '../queue.js';

type TestPlanPriority = 'Must' | 'Recommended' | 'Exploratory';
type TestPlanCaseType = 'Functional' | 'Regression' | 'Negative' | 'Integration' | 'Security' | 'Performance' | 'Exploratory';
type TestPlanRisk = 'High' | 'Medium' | 'Low';
type TestChecklistStatus = 'queued' | 'running' | 'completed' | 'failed';

const DEFAULT_TEST_CHECKLIST_TEMPLATE_URL =
  process.env.TEST_CHECKLIST_TEMPLATE_URL?.trim() ||
  'https://raw.githubusercontent.com/microsoft/PowerToys/releaseChecklist/doc/releases/tests-checklist-template-advanced-paste-section.md';

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

function inferRisk(priority: TestPlanPriority): TestPlanRisk {
  if (priority === 'Must') return 'High';
  if (priority === 'Recommended') return 'Medium';
  return 'Low';
}

function inferType(priority: TestPlanPriority): TestPlanCaseType {
  if (priority === 'Must') return 'Regression';
  if (priority === 'Exploratory') return 'Exploratory';
  return 'Functional';
}

function toTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeCasePatch(testCase: any, patch: PatchTestPlanCasePatch) {
  if (typeof patch.text === 'string') testCase.text = patch.text;
  if (typeof patch.title === 'string') testCase.title = patch.title;
  if (typeof patch.objective === 'string') testCase.objective = patch.objective;
  if (typeof patch.expected === 'string') testCase.expected = patch.expected;
  if (typeof patch.source === 'string') testCase.source = patch.source;
  if (Array.isArray(patch.preconditions)) testCase.preconditions = normalizeTextList(patch.preconditions);
  if (Array.isArray(patch.steps)) testCase.steps = normalizeTextList(patch.steps);
  if (Array.isArray(patch.sourceRefs)) testCase.sourceRefs = normalizeTextList(patch.sourceRefs);
  if (Array.isArray(patch.tags)) testCase.tags = normalizeTextList(patch.tags).map(toTag).filter(Boolean);
  if (patch.type) testCase.type = patch.type;
  if (patch.risk) testCase.risk = patch.risk;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTestPlanChecklists(raw: any) {
  const items = Array.isArray(raw?.items)
    ? raw.items
        .map((item: any) => {
          if (!item || typeof item.prNumber !== 'number') return null;
          const status = item.status as TestChecklistStatus;
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
            sourceRefs: normalizeTextList(item.sourceRefs),
            templateUrl: typeof item.templateUrl === 'string' ? item.templateUrl : null,
          };
        })
        .filter((item: any) => Boolean(item))
    : [];

  const summary = {
    total: items.length,
    queued: items.filter((item: any) => item.status === 'queued').length,
    running: items.filter((item: any) => item.status === 'running').length,
    completed: items.filter((item: any) => item.status === 'completed').length,
    failed: items.filter((item: any) => item.status === 'failed').length,
  };

  const generatedAt = typeof raw?.generatedAt === 'string'
    ? raw.generatedAt
    : (summary.total > 0 && summary.queued === 0 && summary.running === 0 ? nowIso() : null);

  return {
    templateUrl: typeof raw?.templateUrl === 'string' ? raw.templateUrl : null,
    queuedAt: typeof raw?.queuedAt === 'string' ? raw.queuedAt : null,
    generatedAt,
    summary,
    items,
  };
}

function normalizeTestPlanArtifact(data: any, sessionId: string): { sessionId: string; sections: any[]; checklists: any } {
  const rawSections = Array.isArray(data?.sections) ? data.sections : [];
  let caseCounter = 1;

  return {
    sessionId: data?.sessionId ?? sessionId,
    sections: rawSections.map((section: any) => {
      const area = typeof section?.area === 'string' && section.area.trim() ? section.area.trim() : 'General';
      const rawCases = Array.isArray(section?.cases) ? section.cases : [];
      const cases = rawCases.map((testCase: any) => {
        const id = typeof testCase?.id === 'string' && testCase.id.trim() ? testCase.id.trim() : `tc-${caseCounter++}`;
        const priority: TestPlanPriority = testCase?.priority ?? 'Recommended';
        const source = typeof testCase?.source === 'string' && testCase.source.trim() ? testCase.source.trim() : area;
        const title = typeof testCase?.title === 'string' && testCase.title.trim()
          ? testCase.title.trim()
          : (typeof testCase?.text === 'string' && testCase.text.trim() ? testCase.text.trim() : 'Validate release behavior');
        const text = typeof testCase?.text === 'string' && testCase.text.trim() ? testCase.text.trim() : title;
        const objective = typeof testCase?.objective === 'string' && testCase.objective.trim() ? testCase.objective.trim() : text;
        const preconditions = normalizeTextList(testCase?.preconditions);
        const steps = normalizeTextList(testCase?.steps);
        const sourceRefs = uniq([...normalizeTextList(testCase?.sourceRefs), source, area]);
        const tags = uniq([
          ...normalizeTextList(testCase?.tags).map(toTag).filter(Boolean),
          toTag(priority),
          toTag(testCase?.type ?? inferType(priority)),
          toTag(area),
        ]);

        return {
          id,
          text,
          title,
          objective,
          preconditions: preconditions.length ? preconditions : ['Use a build containing this release change.'],
          steps: steps.length ? steps : [`Run scenario: ${title}`],
          expected: typeof testCase?.expected === 'string' && testCase.expected.trim()
            ? testCase.expected.trim()
            : 'Expected behavior is observed and no unexpected error is shown.',
          checked: Boolean(testCase?.checked),
          priority,
          type: testCase?.type ?? inferType(priority),
          risk: testCase?.risk ?? inferRisk(priority),
          source,
          sourceRefs: sourceRefs.length ? sourceRefs : [source],
          tags: tags.length ? tags : ['release'],
        };
      });

      return { area, cases };
    }),
    checklists: normalizeTestPlanChecklists(data?.checklists),
  };
}

export function registerSessionRoutes(server: FastifyInstance, store: PgStore) {
  const enqueueSessionRun = createSessionRunEnqueuer(server);
  const enqueueCommitRegen = createCommitRegenEnqueuer(server);
  const enqueueTestChecklist = createTestChecklistEnqueuer(server);

  // ─────────────────────────────────────────────────────────────────────────────
  // Sessions
  // ─────────────────────────────────────────────────────────────────────────────

  server.get('/sessions', async () => ({ items: await store.listSessions() }));

  server.post('/sessions', async (req, reply) => {
    const body = req.body as {
      name: string;
      repoFullName: string;
      baseRef: string;
      headRef: string;
      options: {
        normalizeBy?: 'pr' | 'commit';
        outputLanguage?: 'english' | 'chinese' | 'bilingual';
        strictMode?: boolean;
      };
    };

    const created = await store.createSession(body);

    if (enqueueSessionRun) {
      try {
        await enqueueSessionRun(created.id);
      } catch (e) {
        req.log.error({ err: e, sessionId: created.id }, 'Failed to enqueue session-run message');
        // Rollback: delete the session since we can't process it
        await store.deleteSession(created.id);
        return reply.code(500).send({ message: 'Failed to queue session for processing' });
      }
    } else {
      // No queue configured - delete session and return error
      await store.deleteSession(created.id);
      return reply.code(503).send({ message: 'Session processing is not available (queue not configured)' });
    }

    reply.code(201).send(created);
  });

  server.get('/sessions/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = await store.getSession(sessionId);
    if (!session) return reply.code(404).send({ message: 'Session not found' });
    return session;
  });

  server.delete('/sessions/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    // Idempotent delete: return 204 even when the session no longer exists.
    await store.deleteSession(sessionId);
    return reply.code(204).send();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Jobs
  // ─────────────────────────────────────────────────────────────────────────────

  server.get('/sessions/:sessionId/jobs', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await store.getSession(sessionId))) return reply.code(404).send({ message: 'Session not found' });
    return { items: await store.listJobs(sessionId) };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Artifacts: Changes
  // ─────────────────────────────────────────────────────────────────────────────

  server.get('/sessions/:sessionId/artifacts/changes', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await store.getSession(sessionId))) return reply.code(404).send({ message: 'Session not found' });
    const data = await store.getArtifact(sessionId, 'changes');
    return data ?? { sessionId, items: [] };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Artifacts: Release Notes
  // ─────────────────────────────────────────────────────────────────────────────

  server.get('/sessions/:sessionId/artifacts/release-notes', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await store.getSession(sessionId))) return reply.code(404).send({ message: 'Session not found' });
    const data = await store.getArtifact(sessionId, 'release-notes');
    return data ?? { sessionId, sections: [] };
  });

  server.patch('/sessions/:sessionId/artifacts/release-notes', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await store.getSession(sessionId))) return reply.code(404).send({ message: 'Session not found' });

    const body = req.body as { operations: PatchReleaseNotesOp[] };
    const existing = (await store.getArtifact(sessionId, 'release-notes')) ?? { sessionId, sections: [] as any[] };
    const next = cloneJson(existing);

    for (const op of body.operations ?? []) {
      if (op.op === 'addItem') {
        const itemId = op.itemId?.trim() || randomUUID();
        const section = ensureSection(next.sections, op.area, () => ({ area: op.area, items: [] as any[] }));
        section.items.push({
          id: itemId,
          text: op.text,
          source: { kind: 'manual', ref: 'manual' },
          excluded: false,
        });
        continue;
      }

      const section = next.sections.find((s: any) => (s.items ?? []).some((i: any) => i.id === op.itemId));
      const item = section?.items?.find((i: any) => i.id === op.itemId);
      if (!item) continue;

      if (op.op === 'updateText') item.text = op.text;
      if (op.op === 'exclude') item.excluded = true;
      if (op.op === 'include') item.excluded = false;
    }

    await store.upsertArtifact(sessionId, 'release-notes', next);
    return next;
  });

  server.post('/sessions/:sessionId/artifacts/release-notes/items/:itemId/regenerate', async (req, reply) => {
    const { sessionId, itemId } = req.params as { sessionId: string; itemId: string };

    const session = await store.getSession(sessionId);
    if (!session) return reply.code(404).send({ message: 'Session not found' });

    const artifact = await store.getArtifact(sessionId, 'release-notes');
    if (!artifact) return reply.code(404).send({ message: 'Release notes artifact not found' });

    // Find the item
    let foundItem: any = null;
    for (const section of artifact.sections ?? []) {
      const item = (section.items ?? []).find((i: any) => i.id === itemId);
      if (item) {
        foundItem = item;
        break;
      }
    }

    if (!foundItem) return reply.code(404).send({ message: 'Item not found' });
    if (foundItem.source?.kind !== 'commit') {
      return reply.code(400).send({ message: 'Only commit-sourced items can be regenerated' });
    }

    const commitSha = foundItem.source.ref;

    // Mark as regenerating
    await store.setCommitSummaryStatus(session.repoFullName, commitSha, 'regenerating');

    const next = cloneJson(artifact);
    for (const section of next.sections ?? []) {
      const item = (section.items ?? []).find((i: any) => i.id === itemId);
      if (item) {
        item.status = 'regenerating';
        break;
      }
    }
    await store.upsertArtifact(sessionId, 'release-notes', next);

    // Enqueue regeneration
    if (enqueueCommitRegen) {
      try {
        await enqueueCommitRegen({ sessionId, itemId, commitSha, repoFullName: session.repoFullName });
      } catch (e) {
        req.log.error({ err: e, sessionId, itemId }, 'Failed to enqueue commit-regen message');
        // Revert on failure
        await store.setCommitSummaryStatus(session.repoFullName, commitSha, 'ready');
        for (const section of next.sections ?? []) {
          const item = (section.items ?? []).find((i: any) => i.id === itemId);
          if (item) {
            item.status = 'ready';
            break;
          }
        }
        await store.upsertArtifact(sessionId, 'release-notes', next);
        return reply.code(500).send({ message: 'Failed to enqueue regeneration' });
      }
    }

    reply.code(202).send({ message: 'Regeneration started', itemId, commitSha });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Artifacts: Hotspots
  // ─────────────────────────────────────────────────────────────────────────────

  server.get('/sessions/:sessionId/artifacts/hotspots', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await store.getSession(sessionId))) return reply.code(404).send({ message: 'Session not found' });
    const data = await store.getArtifact(sessionId, 'hotspots');
    return data ?? { sessionId, items: [] };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Artifacts: Test Plan
  // ─────────────────────────────────────────────────────────────────────────────

  server.get('/sessions/:sessionId/artifacts/test-plan', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await store.getSession(sessionId))) return reply.code(404).send({ message: 'Session not found' });
    const data = await store.getArtifact(sessionId, 'test-plan');
    if (!data) return normalizeTestPlanArtifact({ sessionId, sections: [] }, sessionId);
    return normalizeTestPlanArtifact(data, sessionId);
  });

  server.post('/sessions/:sessionId/artifacts/test-plan/checklists/queue', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await store.getSession(sessionId))) return reply.code(404).send({ message: 'Session not found' });
    if (!enqueueTestChecklist) return reply.code(501).send({ message: 'Test checklist queue is not configured' });

    const body = (req.body ?? {}) as {
      prNumbers?: number[];
      templateUrl?: string;
    };

    const changes = await store.getArtifact(sessionId, 'changes');
    const changeItems = Array.isArray(changes?.items) ? changes.items : [];
    if (!changeItems.length) {
      return reply.code(409).send({ message: 'Changes artifact is missing. Generate session changes first.' });
    }

    const requestedNumbers = Array.isArray(body.prNumbers)
      ? new Set(
          body.prNumbers
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n > 0)
        )
      : null;

    const targets = changeItems.filter((item: any) => {
      const prNumber = Number(item?.number);
      if (!Number.isFinite(prNumber) || prNumber <= 0) return false;
      return requestedNumbers ? requestedNumbers.has(prNumber) : true;
    });

    if (!targets.length) {
      return reply.code(400).send({ message: 'No matching PRs found for checklist generation' });
    }

    const templateUrl = typeof body.templateUrl === 'string' && body.templateUrl.trim()
      ? body.templateUrl.trim()
      : DEFAULT_TEST_CHECKLIST_TEMPLATE_URL;

    const existing = (await store.getArtifact(sessionId, 'test-plan')) ?? { sessionId, sections: [] as any[] };
    const next = normalizeTestPlanArtifact(existing, sessionId);
    const queuedAt = nowIso();
    next.checklists.templateUrl = templateUrl;
    next.checklists.queuedAt = queuedAt;
    next.checklists.generatedAt = null;

    for (const item of targets) {
      const prNumber = Number(item.number);
      const existingChecklist = next.checklists.items.find((check: any) => check.prNumber === prNumber);
      if (existingChecklist) {
        existingChecklist.area = typeof item.area === 'string' ? item.area : 'General';
        existingChecklist.title = typeof item.title === 'string' ? item.title : `PR #${prNumber}`;
        existingChecklist.status = 'queued';
        existingChecklist.error = null;
        existingChecklist.templateUrl = templateUrl;
        existingChecklist.updatedAt = queuedAt;
        existingChecklist.sourceRefs = uniq([`PR #${prNumber}`, `Area: ${existingChecklist.area}`]);
      } else {
        next.checklists.items.push({
          id: `pr-${prNumber}`,
          prNumber,
          area: typeof item.area === 'string' ? item.area : 'General',
          title: typeof item.title === 'string' ? item.title : `PR #${prNumber}`,
          status: 'queued',
          markdown: null,
          error: null,
          updatedAt: queuedAt,
          sourceRefs: uniq([`PR #${prNumber}`, `Area: ${typeof item.area === 'string' ? item.area : 'General'}`]),
          templateUrl,
        });
      }
    }

    next.checklists.summary = {
      total: next.checklists.items.length,
      queued: next.checklists.items.filter((check: any) => check.status === 'queued').length,
      running: next.checklists.items.filter((check: any) => check.status === 'running').length,
      completed: next.checklists.items.filter((check: any) => check.status === 'completed').length,
      failed: next.checklists.items.filter((check: any) => check.status === 'failed').length,
    };

    await store.upsertArtifact(sessionId, 'test-plan', next);

    for (const item of targets) {
      await enqueueTestChecklist({
        sessionId,
        prNumber: Number(item.number),
        templateUrl,
      });
    }

    return reply.code(202).send({
      status: 'queued',
      queued: targets.length,
      templateUrl,
    });
  });

  server.patch('/sessions/:sessionId/artifacts/test-plan', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await store.getSession(sessionId))) return reply.code(404).send({ message: 'Session not found' });

    const body = req.body as { operations: PatchTestPlanOp[] };
    const existing = (await store.getArtifact(sessionId, 'test-plan')) ?? { sessionId, sections: [] as any[] };
    const next = cloneJson(normalizeTestPlanArtifact(existing, sessionId));

    for (const op of body.operations ?? []) {
      if (op.op === 'addCase') {
        const caseId = op.caseId?.trim() || randomUUID();
        const section = ensureSection(next.sections, op.area, () => ({ area: op.area, cases: [] as any[] }));
        const priority = op.priority ?? 'Recommended';
        section.cases.push({
          id: caseId,
          text: op.text,
          title: op.text,
          objective: op.text,
          preconditions: ['Use a build containing this release change.'],
          steps: [`Run scenario: ${op.text}`],
          expected: 'Expected behavior is observed and no unexpected error is shown.',
          checked: false,
          priority,
          type: inferType(priority),
          risk: inferRisk(priority),
          source: 'manual',
          sourceRefs: ['manual', op.area],
          tags: uniq(['manual', toTag(op.area), toTag(priority)]),
        });
        continue;
      }

      const section = next.sections.find((s: any) => (s.cases ?? []).some((c: any) => c.id === op.caseId));
      const testCase = section?.cases?.find((c: any) => c.id === op.caseId);
      if (!testCase) continue;

      if (op.op === 'updateText') {
        const previousText = testCase.text;
        testCase.text = op.text;
        if (!testCase.title || testCase.title === testCase.objective || testCase.title === previousText) {
          testCase.title = op.text;
        }
      }
      if (op.op === 'check') testCase.checked = true;
      if (op.op === 'uncheck') testCase.checked = false;
      if (op.op === 'changePriority') {
        testCase.priority = op.priority;
        if (!testCase.risk) testCase.risk = inferRisk(op.priority);
        if (!testCase.type) testCase.type = inferType(op.priority);
      }
      if (op.op === 'updateCase') {
        normalizeCasePatch(testCase, op.patch ?? {});
      }
      if (op.op === 'deleteCase') {
        section.cases = section.cases.filter((c: any) => c.id !== op.caseId);
        next.sections = next.sections.filter((s: any) => (s.cases ?? []).length > 0);
      }
    }

    const normalized = normalizeTestPlanArtifact(next, sessionId);
    await store.upsertArtifact(sessionId, 'test-plan', normalized);
    return normalized;
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Exports
  // ─────────────────────────────────────────────────────────────────────────────

  server.post('/sessions/:sessionId/exports', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await store.getSession(sessionId))) return reply.code(404).send({ message: 'Session not found' });
    const _body = req.body as { targets: string[] };
    // TODO: persist export record + blob outputs; returning a stub for now.
    reply.code(201).send({
      exportId: randomUUID(),
      createdAt: new Date().toISOString(),
      results: {},
    });
  });
}

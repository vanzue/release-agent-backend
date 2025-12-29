import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { PgStore } from '../store/pg.js';
import type { PatchReleaseNotesOp, PatchTestPlanOp } from '@release-agent/contracts';
import { cloneJson, ensureSection } from '../utils.js';
import { createSessionRunEnqueuer, createCommitRegenEnqueuer } from '../queue.js';

export function registerSessionRoutes(server: FastifyInstance, store: PgStore) {
  const enqueueSessionRun = createSessionRunEnqueuer(server);
  const enqueueCommitRegen = createCommitRegenEnqueuer(server);

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
    const deleted = await store.deleteSession(sessionId);
    if (!deleted) return reply.code(404).send({ message: 'Session not found' });
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
    return data ?? { sessionId, sections: [] };
  });

  server.patch('/sessions/:sessionId/artifacts/test-plan', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await store.getSession(sessionId))) return reply.code(404).send({ message: 'Session not found' });

    const body = req.body as { operations: PatchTestPlanOp[] };
    const existing = (await store.getArtifact(sessionId, 'test-plan')) ?? { sessionId, sections: [] as any[] };
    const next = cloneJson(existing);

    for (const op of body.operations ?? []) {
      if (op.op === 'addCase') {
        const caseId = op.caseId?.trim() || randomUUID();
        const section = ensureSection(next.sections, op.area, () => ({ area: op.area, cases: [] as any[] }));
        section.cases.push({
          id: caseId,
          text: op.text,
          checked: false,
          priority: op.priority ?? 'Recommended',
          source: 'manual',
        });
        continue;
      }

      const section = next.sections.find((s: any) => (s.cases ?? []).some((c: any) => c.id === op.caseId));
      const testCase = section?.cases?.find((c: any) => c.id === op.caseId);
      if (!testCase) continue;

      if (op.op === 'updateText') testCase.text = op.text;
      if (op.op === 'check') testCase.checked = true;
      if (op.op === 'uncheck') testCase.checked = false;
      if (op.op === 'changePriority') testCase.priority = op.priority;
      if (op.op === 'deleteCase') {
        section.cases = section.cases.filter((c: any) => c.id !== op.caseId);
        next.sections = next.sections.filter((s: any) => (s.cases ?? []).length > 0);
      }
    }

    await store.upsertArtifact(sessionId, 'test-plan', next);
    return next;
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

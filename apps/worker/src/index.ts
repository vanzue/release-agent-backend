import pino from 'pino';
import { ServiceBusClient } from '@azure/service-bus';
import { createDb } from './db.js';
import { setJob, setSessionStatus } from './store.js';
import { runSession, regenerateCommitSummary } from './sessionRunner.js';
import type { RegenerateReleaseNoteRequest } from '@release-agent/contracts';
import type { IssueReclusterRequest, IssueSyncRequest } from './issues/types.js';
import { syncIssues } from './issues/sync.js';
import { reclusterBucket } from './issues/recluster.js';
import { getIssueSyncState, setIssueSyncingStatus } from './issues/issueStore.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

// Queue names
const sessionRunQueueName = process.env.SERVICEBUS_SESSION_RUN_QUEUE ?? 'session-run';
const commitRegenQueueName = process.env.SERVICEBUS_COMMIT_REGEN_QUEUE ?? 'commit-regen';
const issueSyncQueueName = process.env.SERVICEBUS_ISSUE_SYNC_QUEUE ?? 'issue-sync';
const issueReclusterQueueName = process.env.SERVICEBUS_ISSUE_RECLUSTER_QUEUE ?? 'issue-recluster';
const connectionString = process.env.SERVICEBUS_CONNECTION_STRING;

if (!connectionString) {
  logger.error('Missing SERVICEBUS_CONNECTION_STRING; worker will not start.');
  process.exit(1);
}

// Initialize Service Bus client and receivers
const client = new ServiceBusClient(connectionString);
const sessionRunReceiver = client.createReceiver(sessionRunQueueName);
const commitRegenReceiver = client.createReceiver(commitRegenQueueName);
const issueSyncReceiver = client.createReceiver(issueSyncQueueName);
const issueReclusterReceiver = client.createReceiver(issueReclusterQueueName);
const db = createDb();

// Automatic sync on worker startup (and optionally on a timer).
const autoSyncRepos = (process.env.ISSUE_AUTO_SYNC_REPOS ?? 'microsoft/PowerToys')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const autoSyncIntervalMinutes = Number.parseInt(process.env.ISSUE_AUTO_SYNC_INTERVAL_MINUTES ?? '0', 10);

const running = new Set<string>();

const runAutoSync = async (repoFullName: string) => {
  if (running.has(repoFullName)) return;
  
  // Check if already syncing (from previous worker run or another instance)
  const syncState = await getIssueSyncState(db, repoFullName);
  if (syncState.isSyncing) {
    logger.info({ repoFullName }, 'Skipping auto sync - already syncing');
    return;
  }
  
  running.add(repoFullName);
  try {
    logger.info({ repoFullName }, 'Auto issue sync starting');
    await setIssueSyncingStatus(db, repoFullName, true);
    await syncIssues(db, { repoFullName, fullSync: false });
    logger.info({ repoFullName }, 'Auto issue sync done');
  } catch (e) {
    logger.error({ err: e, repoFullName }, 'Auto issue sync failed');
  } finally {
    await setIssueSyncingStatus(db, repoFullName, false);
    running.delete(repoFullName);
  }
};

// Always run once at startup.
for (const repoFullName of autoSyncRepos) {
  void runAutoSync(repoFullName);
}

// Optional periodic sync.
if (autoSyncIntervalMinutes > 0) {
  const intervalMs = autoSyncIntervalMinutes * 60_000;
  setInterval(() => {
    for (const repoFullName of autoSyncRepos) {
      void runAutoSync(repoFullName);
    }
  }, intervalMs);
}

// Subscribe to session-run queue
const sessionRunSubscription = sessionRunReceiver.subscribe({
  async processMessage(message) {
    logger.info({ messageId: message.messageId, body: message.body }, 'Received session-run message');

    const body = message.body as any;
    const sessionId = typeof body === 'string' ? body : body?.sessionId;
    if (!sessionId || typeof sessionId !== 'string') {
      logger.error({ messageId: message.messageId, body }, 'Invalid message body; expected {sessionId}');
      return;
    }

    try {
      await runSession(db, sessionId);
      logger.info({ sessionId }, 'Session run completed');
    } catch (e) {
      logger.error({ err: e, sessionId }, 'Session run failed');
      try {
        await setJob(db, sessionId, 'parse-changes', 'failed', 100, e instanceof Error ? e.message : String(e));
        await setJob(db, sessionId, 'generate-notes', 'failed', 100, e instanceof Error ? e.message : String(e));
        await setJob(db, sessionId, 'analyze-hotspots', 'failed', 100, e instanceof Error ? e.message : String(e));
        await setJob(db, sessionId, 'generate-testplan', 'failed', 100, e instanceof Error ? e.message : String(e));
        await setSessionStatus(db, sessionId, 'generating');
      } catch (inner) {
        logger.error({ err: inner, sessionId }, 'Failed to record failure state');
      }
    }
  },
  async processError(args) {
    logger.error({ args }, 'Service Bus session-run receiver error');
  },
});

// Subscribe to commit-regen queue
const commitRegenSubscription = commitRegenReceiver.subscribe({
  async processMessage(message) {
    logger.info({ messageId: message.messageId, body: message.body }, 'Received commit-regen message');

    const body = message.body as RegenerateReleaseNoteRequest;
    if (!body?.sessionId || !body?.itemId || !body?.commitSha || !body?.repoFullName) {
      logger.error({ messageId: message.messageId, body }, 'Invalid message body; expected RegenerateReleaseNoteRequest');
      return;
    }

    try {
      await regenerateCommitSummary(db, body);
    } catch (e) {
      logger.error({ err: e, body }, 'Commit regeneration failed');
    }
  },
  async processError(args) {
    logger.error({ args }, 'Service Bus commit-regen receiver error');
  },
});

// Subscribe to issue-sync queue
const issueSyncSubscription = issueSyncReceiver.subscribe({
  async processMessage(message) {
    logger.info({ messageId: message.messageId, body: message.body }, 'Received issue-sync message');

    const body = message.body as IssueSyncRequest;
    if (!body?.repoFullName) {
      logger.error({ messageId: message.messageId, body }, 'Invalid message body; expected IssueSyncRequest');
      return;
    }

    try {
      await setIssueSyncingStatus(db, body.repoFullName, true);
      await syncIssues(db, body);
    } catch (e) {
      logger.error({ err: e, body }, 'Issue sync failed');
    } finally {
      await setIssueSyncingStatus(db, body.repoFullName, false);
    }
  },
  async processError(args) {
    logger.error({ args }, 'Service Bus issue-sync receiver error');
  },
});

// Subscribe to issue-recluster queue
const issueReclusterSubscription = issueReclusterReceiver.subscribe({
  async processMessage(message) {
    logger.info({ messageId: message.messageId, body: message.body }, 'Received issue-recluster message');

    const body = message.body as IssueReclusterRequest;
    if (!body?.repoFullName || !body?.productLabel || typeof body.threshold !== 'number' || typeof body.topK !== 'number') {
      logger.error({ messageId: message.messageId, body }, 'Invalid message body; expected IssueReclusterRequest');
      return;
    }

    try {
      await reclusterBucket(db, body);
    } catch (e) {
      logger.error({ err: e, body }, 'Issue recluster failed');
    }
  },
  async processError(args) {
    logger.error({ args }, 'Service Bus issue-recluster receiver error');
  },
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  await sessionRunSubscription.close();
  await commitRegenSubscription.close();
  await issueSyncSubscription.close();
  await issueReclusterSubscription.close();
  await sessionRunReceiver.close();
  await commitRegenReceiver.close();
  await issueSyncReceiver.close();
  await issueReclusterReceiver.close();
  await client.close();
  await db.pool.end();
  process.exit(0);
});

logger.info(
  { sessionRunQueueName, commitRegenQueueName, issueSyncQueueName, issueReclusterQueueName },
  'Worker started; waiting for messages'
);

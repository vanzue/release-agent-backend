import pino from 'pino';
import { ServiceBusClient } from '@azure/service-bus';
import { createDb } from './db.js';
import { setJob, setSessionStatus } from './store.js';
import { runSession, regenerateCommitSummary } from './sessionRunner.js';
import type { RegenerateReleaseNoteRequest } from '@release-agent/contracts';
import type { IssueReclusterRequest, IssueSyncRequest } from './issues/types.js';
import { syncIssues } from './issues/sync.js';
import { reclusterBucket } from './issues/recluster.js';
import { getIssueSyncState } from './issues/issueStore.js';

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

// Continuous issue sync - runs forever, polling for new issues
const autoSyncRepos = (process.env.ISSUE_AUTO_SYNC_REPOS ?? 'microsoft/PowerToys')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const syncSleepMinutes = Number.parseInt(process.env.ISSUE_SYNC_SLEEP_MINUTES ?? '5', 10);

const runContinuousSync = async (repoFullName: string) => {
  logger.info({ repoFullName, syncSleepMinutes }, 'Starting continuous issue sync');
  
  while (true) {
    try {
      const result = await syncIssues(db, { repoFullName, fullSync: false });
      logger.info({ repoFullName, fetched: result.fetched, embedded: result.embedded }, 'Sync cycle complete');
      
      // Sleep before next poll
      logger.debug({ repoFullName, sleepMinutes: syncSleepMinutes }, 'Sleeping before next sync');
      await new Promise(resolve => setTimeout(resolve, syncSleepMinutes * 60_000));
    } catch (e) {
      logger.error({ err: e, repoFullName }, 'Sync cycle failed, will retry after sleep');
      await new Promise(resolve => setTimeout(resolve, syncSleepMinutes * 60_000));
    }
  }
};

// Start continuous sync for each repo
for (const repoFullName of autoSyncRepos) {
  void runContinuousSync(repoFullName);
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
      await syncIssues(db, body);
    } catch (e) {
      logger.error({ err: e, body }, 'Issue sync failed');
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

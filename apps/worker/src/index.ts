import pino from 'pino';
import { ServiceBusClient } from '@azure/service-bus';
import { createDb } from './db.js';
import { setJob, setSessionStatus } from './store.js';
import { runSession, regenerateCommitSummary } from './sessionRunner.js';
import type { RegenerateReleaseNoteRequest } from '@release-agent/contracts';

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
const connectionString = process.env.SERVICEBUS_CONNECTION_STRING;

if (!connectionString) {
  logger.error('Missing SERVICEBUS_CONNECTION_STRING; worker will not start.');
  process.exit(1);
}

// Initialize Service Bus client and receivers
const client = new ServiceBusClient(connectionString);
const sessionRunReceiver = client.createReceiver(sessionRunQueueName);
const commitRegenReceiver = client.createReceiver(commitRegenQueueName);
const db = createDb();

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

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  await sessionRunSubscription.close();
  await commitRegenSubscription.close();
  await sessionRunReceiver.close();
  await commitRegenReceiver.close();
  await client.close();
  await db.pool.end();
  process.exit(0);
});

logger.info({ sessionRunQueueName, commitRegenQueueName }, 'Worker started; waiting for messages');

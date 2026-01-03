import type { FastifyInstance } from 'fastify';
import { ServiceBusClient, type ServiceBusSender } from '@azure/service-bus';
import type { IssueReclusterRequest, IssueSyncRequest, RegenerateReleaseNoteRequest } from '@release-agent/contracts';

export type SessionRunEnqueuer = (sessionId: string) => Promise<void>;
export type CommitRegenEnqueuer = (request: RegenerateReleaseNoteRequest) => Promise<void>;
export type IssueSyncEnqueuer = (request: IssueSyncRequest) => Promise<void>;
export type IssueReclusterEnqueuer = (request: IssueReclusterRequest) => Promise<void>;

function createEnqueuer<T>(
  server: FastifyInstance,
  queueName: string,
  subject: string
): ((body: T) => Promise<void>) | null {
  const connectionString = process.env.SERVICEBUS_CONNECTION_STRING;
  if (!connectionString) return null;

  const client = new ServiceBusClient(connectionString);
  const sender: ServiceBusSender = client.createSender(queueName);

  server.addHook('onClose', async () => {
    await sender.close();
    await client.close();
  });

  return async (body: T) => {
    await sender.sendMessages({
      body,
      contentType: 'application/json',
      subject,
    });
  };
}

/**
 * Create an enqueuer for session-run messages.
 */
export function createSessionRunEnqueuer(server: FastifyInstance): SessionRunEnqueuer | null {
  const queueName = process.env.SERVICEBUS_SESSION_RUN_QUEUE ?? 'session-run';
  const enqueue = createEnqueuer<{ sessionId: string }>(server, queueName, 'session-run');
  if (!enqueue) return null;
  return (sessionId: string) => enqueue({ sessionId });
}

/**
 * Create an enqueuer for commit-regen messages.
 */
export function createCommitRegenEnqueuer(server: FastifyInstance): CommitRegenEnqueuer | null {
  const queueName = process.env.SERVICEBUS_COMMIT_REGEN_QUEUE ?? 'commit-regen';
  return createEnqueuer<RegenerateReleaseNoteRequest>(server, queueName, 'commit-regen');
}

export function createIssueSyncEnqueuer(server: FastifyInstance): IssueSyncEnqueuer | null {
  const queueName = process.env.SERVICEBUS_ISSUE_SYNC_QUEUE ?? 'issue-sync';
  return createEnqueuer<IssueSyncRequest>(server, queueName, 'issue-sync');
}

export function createIssueReclusterEnqueuer(server: FastifyInstance): IssueReclusterEnqueuer | null {
  const queueName = process.env.SERVICEBUS_ISSUE_RECLUSTER_QUEUE ?? 'issue-recluster';
  return createEnqueuer<IssueReclusterRequest>(server, queueName, 'issue-recluster');
}

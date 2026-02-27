import { ServiceBusClient, type ServiceBusSender } from '@azure/service-bus';
import type { GenerateTestChecklistRequest } from '@release-agent/contracts';

let serviceBusClient: ServiceBusClient | null = null;
let checklistSender: ServiceBusSender | null = null;

function getChecklistSender(): ServiceBusSender {
  if (checklistSender) return checklistSender;

  const connectionString = process.env.SERVICEBUS_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('Missing SERVICEBUS_CONNECTION_STRING');
  }

  const queueName = process.env.SERVICEBUS_TESTPLAN_CHECKLIST_QUEUE ?? 'testplan-checklist';
  serviceBusClient = new ServiceBusClient(connectionString);
  checklistSender = serviceBusClient.createSender(queueName);
  return checklistSender;
}

export async function enqueueTestChecklistJobs(requests: GenerateTestChecklistRequest[]): Promise<void> {
  if (!requests.length) return;
  const sender = getChecklistSender();
  await sender.sendMessages(
    requests.map((request) => ({
      body: request,
      contentType: 'application/json',
      subject: 'testplan-checklist',
    }))
  );
}

export async function closeWorkerQueueResources(): Promise<void> {
  await checklistSender?.close();
  checklistSender = null;
  await serviceBusClient?.close();
  serviceBusClient = null;
}

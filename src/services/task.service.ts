import { CloudTasksClient, protos } from '@google-cloud/tasks';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

let tasksClientInstance: CloudTasksClient | null = null;

export function getTasksClient(): CloudTasksClient {
  if (!tasksClientInstance) {
    tasksClientInstance = new CloudTasksClient();
  }
  return tasksClientInstance;
}

export function setTasksClient(client: CloudTasksClient | null): void {
  tasksClientInstance = client;
}

export interface ScheduleTaskResult {
  taskName: string;
  scheduledTime: string;
  alreadyExisted?: boolean;
}

export class TaskService {
  /**
   * Schedules a delayed background processing task in Google Cloud Tasks.
   *
   * @param transactionId The unique transaction ID to process
   * @param delaySeconds Scheduling delay in seconds (default: 30 seconds)
   */
  async scheduleTransactionProcessing(
    transactionId: string,
    delaySeconds = 30
  ): Promise<ScheduleTaskResult> {
    const client = getTasksClient();
    const parent = client.queuePath(
      env.GCP_PROJECT_ID,
      env.CLOUD_TASKS_LOCATION,
      env.CLOUD_TASKS_QUEUE
    );

    // Sanitize transactionId to conform to Cloud Tasks task name specifications:
    // [a-zA-Z0-9_-], up to 500 characters.
    const sanitizedId = transactionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const taskName = `${parent}/tasks/txn-${sanitizedId}`;

    const scheduledDate = new Date(Date.now() + delaySeconds * 1000);
    const scheduleSeconds = Math.floor(scheduledDate.getTime() / 1000);

    const targetUrl = `${env.CLOUD_RUN_SERVICE_URL.replace(/\/+$/, '')}/internal/process-transaction`;

    const payload = { transaction_id: transactionId };
    const bodyBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Google-Cloud-Tasks/wh-service',
    };

    if (env.INTERNAL_AUTH_TOKEN) {
      headers['X-Internal-Token'] = env.INTERNAL_AUTH_TOKEN;
    }

    const httpRequest: protos.google.cloud.tasks.v2.IHttpRequest = {
      httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
      url: targetUrl,
      headers,
      body: bodyBase64 as unknown as Uint8Array,
    };

    // If dedicated service account email is configured, attach OIDC token configuration
    if (env.CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL) {
      httpRequest.oidcToken = {
        serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL,
        audience: env.CLOUD_RUN_SERVICE_URL,
      };
    }

    const task: protos.google.cloud.tasks.v2.ITask = {
      name: taskName,
      httpRequest,
      scheduleTime: {
        seconds: scheduleSeconds,
      },
    };

    try {
      logger.info('Scheduling Cloud Task for transaction', {
        transaction_id: transactionId,
        task_name: taskName,
        target_url: targetUrl,
        delay_seconds: delaySeconds,
        scheduled_for: scheduledDate.toISOString(),
      });

      const [response] = await client.createTask({
        parent,
        task,
      });

      logger.info('Cloud Task scheduled successfully', {
        transaction_id: transactionId,
        task_name: response.name,
      });

      return {
        taskName: response.name || taskName,
        scheduledTime: scheduledDate.toISOString(),
      };
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string; details?: string };

      // Handle gRPC code 6: ALREADY_EXISTS (task with this name already scheduled)
      if (err.code === 6 || err.message?.includes('ALREADY_EXISTS')) {
        logger.warn('Cloud Task already exists in queue (deduplicated by name)', {
          transaction_id: transactionId,
          task_name: taskName,
        });

        return {
          taskName,
          scheduledTime: scheduledDate.toISOString(),
          alreadyExisted: true,
        };
      }

      logger.error('Failed to create Cloud Task', {
        transaction_id: transactionId,
        error: err.message ?? String(error),
      });

      throw error;
    }
  }
}

export const taskService = new TaskService();

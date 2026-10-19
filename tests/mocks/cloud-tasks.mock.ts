export interface MockScheduledTask {
  parent: string;
  task: {
    name?: string;
    scheduleTime?: { seconds: number };
    httpRequest?: {
      httpMethod?: string;
      url?: string;
      headers?: Record<string, string>;
      body?: unknown;
      oidcToken?: {
        serviceAccountEmail?: string;
        audience?: string;
      };
    };
  };
}

export class MockCloudTasksClient {
  public scheduledTasks: MockScheduledTask[] = [];
  public shouldFail = false;
  public failureError = new Error('Simulated Google Cloud Tasks failure');

  reset(): void {
    this.scheduledTasks = [];
    this.shouldFail = false;
  }

  queuePath(project: string, location: string, queue: string): string {
    return `projects/${project}/locations/${location}/queues/${queue}`;
  }

  async createTask(request: MockScheduledTask): Promise<[{ name: string }]> {
    if (this.shouldFail) {
      throw this.failureError;
    }

    this.scheduledTasks.push(request);
    const taskName = request.task.name || `${request.parent}/tasks/mock-task-${Date.now()}`;
    return [{ name: taskName }];
  }
}

export const mockCloudTasksClient = new MockCloudTasksClient();

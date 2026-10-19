import { beforeEach } from 'vitest';
import { setSupabaseClient } from '../src/lib/supabase.js';
import { setTasksClient } from '../src/services/task.service.js';
import { mockSupabase } from './mocks/supabase.mock.js';
import { mockCloudTasksClient } from './mocks/cloud-tasks.mock.js';
import { SupabaseClient } from '@supabase/supabase-js';
import { CloudTasksClient } from '@google-cloud/tasks';

// Hook mock clients into dependency injection
setSupabaseClient(mockSupabase as unknown as SupabaseClient);
setTasksClient(mockCloudTasksClient as unknown as CloudTasksClient);

beforeEach(() => {
  mockSupabase.reset();
  mockCloudTasksClient.reset();
});

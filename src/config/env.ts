import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  GCP_PROJECT_ID: z.string().min(1, 'GCP_PROJECT_ID is required'),
  CLOUD_TASKS_QUEUE: z.string().default('transaction-tasks'),
  CLOUD_TASKS_LOCATION: z.string().default('asia-south1'),
  CLOUD_RUN_SERVICE_URL: z.string().url().default('http://localhost:8080'),
  CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL: z.string().optional().default(''),
  INTERNAL_AUTH_TOKEN: z.string().optional().default(''),
}).transform((data) => {
  const secretKey = data.SUPABASE_SERVICE_ROLE_KEY || data.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('Either SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY must be provided');
  }
  return {
    ...data,
    SUPABASE_SERVICE_ROLE_KEY: secretKey,
  };
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', JSON.stringify(parsed.error.format(), null, 2));
  if (process.env.NODE_ENV !== 'test') {
    process.exit(1);
  }
}

export const env = parsed.success
  ? parsed.data
  : {
      PORT: 8080,
      NODE_ENV: 'test' as const,
      SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      GCP_PROJECT_ID: 'test-gcp-project',
      CLOUD_TASKS_QUEUE: 'transaction-tasks',
      CLOUD_TASKS_LOCATION: 'us-central1',
      CLOUD_RUN_SERVICE_URL: 'http://localhost:8080',
      CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL: 'tasks@test.iam.gserviceaccount.com',
      INTERNAL_AUTH_TOKEN: 'test-token',
    };

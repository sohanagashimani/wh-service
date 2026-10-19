import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

let clientInstance: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!clientInstance) {
    clientInstance = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return clientInstance;
}

export function setSupabaseClient(client: SupabaseClient | null): void {
  clientInstance = client;
}

export const supabase = {
  from: (table: string) => getSupabaseClient().from(table),
};

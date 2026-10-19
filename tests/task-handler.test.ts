import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { mockSupabase } from './mocks/supabase.mock.js';
import { env } from '../src/config/env.js';

describe('POST /internal/process-transaction - Cloud Tasks Handler', () => {
  const transactionId = 'txn_task_handler_1';

  beforeEach(() => {
    // Seed database with a transaction in PROCESSING state
    mockSupabase.store.set(transactionId, {
      transaction_id: transactionId,
      source_account: 'acc_source_th',
      destination_account: 'acc_dest_th',
      amount: 1000,
      currency: 'USD',
      status: 'PROCESSING',
      is_scheduled: true,
      scheduled_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      processed_at: null,
    });
  });

  it('Requirement 9: Task handler marks transaction as PROCESSED and sets processed_at', async () => {
    const response = await request(app)
      .post('/internal/process-transaction')
      .set('X-Internal-Token', env.INTERNAL_AUTH_TOKEN)
      .set('x-cloudtasks-queuename', env.CLOUD_TASKS_QUEUE)
      .send({ transaction_id: transactionId });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'PROCESSED');
    expect(response.body).toHaveProperty('transaction_id', transactionId);
    expect(response.body).toHaveProperty('processed_at');

    const updated = mockSupabase.store.get(transactionId);
    expect(updated?.status).toBe('PROCESSED');
    expect(updated?.processed_at).not.toBeNull();
  });

  it('Requirement 10: Repeated task delivery does not re-process an already-completed transaction', async () => {
    // Mark as already PROCESSED
    const initialProcessedTime = '2026-10-19T10:00:00.000Z';
    const record = mockSupabase.store.get(transactionId)!;
    record.status = 'PROCESSED';
    record.processed_at = initialProcessedTime;

    const response = await request(app)
      .post('/internal/process-transaction')
      .set('X-Internal-Token', env.INTERNAL_AUTH_TOKEN)
      .set('x-cloudtasks-queuename', env.CLOUD_TASKS_QUEUE)
      .send({ transaction_id: transactionId });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ALREADY_PROCESSED');
    expect(response.body).toHaveProperty('processed_at', initialProcessedTime);

    // Verify processed_at was not overwritten
    const current = mockSupabase.store.get(transactionId);
    expect(current?.processed_at).toBe(initialProcessedTime);
  });

  it('Requirement 12: Transient processing failures return HTTP 500 to trigger Cloud Tasks retries', async () => {
    // Simulate a transient database failure during select
    mockSupabase.shouldFailSelect = true;

    const response = await request(app)
      .post('/internal/process-transaction')
      .set('X-Internal-Token', env.INTERNAL_AUTH_TOKEN)
      .set('x-cloudtasks-queuename', env.CLOUD_TASKS_QUEUE)
      .send({ transaction_id: transactionId });

    // Cloud Tasks requires non-2xx (such as 500) to schedule an exponential backoff retry
    expect(response.status).toBe(500);

    // Now restore database health (simulating retry succeeding)
    mockSupabase.shouldFailSelect = false;
    const retryResponse = await request(app)
      .post('/internal/process-transaction')
      .set('X-Internal-Token', env.INTERNAL_AUTH_TOKEN)
      .set('x-cloudtasks-queuename', env.CLOUD_TASKS_QUEUE)
      .send({ transaction_id: transactionId });

    expect(retryResponse.status).toBe(200);
    expect(retryResponse.body.status).toBe('PROCESSED');
  });

  it('Rejects unauthorized invocation when invalid authentication credentials are provided', async () => {
    // Missing auth header and queue mismatch
    const resForbidden = await request(app)
      .post('/internal/process-transaction')
      .set('x-cloudtasks-queuename', 'wrong-queue-name')
      .send({ transaction_id: transactionId });

    expect(resForbidden.status).toBe(403);

    // Missing internal auth token when expected
    const resUnauthorized = await request(app)
      .post('/internal/process-transaction')
      .set('Authorization', 'Bearer invalid-token')
      .send({ transaction_id: transactionId });

    expect(resUnauthorized.status).toBe(401);
  });

  it('Returns HTTP 404 when transaction is not found (permanent non-retryable)', async () => {
    const response = await request(app)
      .post('/internal/process-transaction')
      .set('X-Internal-Token', env.INTERNAL_AUTH_TOKEN)
      .set('x-cloudtasks-queuename', env.CLOUD_TASKS_QUEUE)
      .send({ transaction_id: 'txn_non_existent' });

    expect(response.status).toBe(404);
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { mockSupabase } from './mocks/supabase.mock.js';
import { mockCloudTasksClient } from './mocks/cloud-tasks.mock.js';

describe('Idempotency & Concurrency Tests', () => {
  const payload = {
    transaction_id: 'txn_idem_123',
    source_account: 'acc_source_1',
    destination_account: 'acc_dest_1',
    amount: 500,
    currency: 'USD',
  };

  it('Requirement 7: Duplicate webhook requests do not create duplicate records or duplicate tasks', async () => {
    // First request
    const res1 = await request(app)
      .post('/v1/webhooks/transactions')
      .send(payload);
    expect(res1.status).toBe(202);

    expect(mockSupabase.store.size).toBe(1);
    expect(mockCloudTasksClient.scheduledTasks.length).toBe(1);

    // Second duplicate request
    const res2 = await request(app)
      .post('/v1/webhooks/transactions')
      .send(payload);
    expect(res2.status).toBe(202);
    expect(res2.body.message).toContain('already');

    // Verify still exactly 1 record and 1 scheduled task
    expect(mockSupabase.store.size).toBe(1);
    expect(mockCloudTasksClient.scheduledTasks.length).toBe(1);

    // Third request when transaction is already marked PROCESSED
    const record = mockSupabase.store.get(payload.transaction_id)!;
    record.status = 'PROCESSED';
    record.processed_at = new Date().toISOString();

    const res3 = await request(app)
      .post('/v1/webhooks/transactions')
      .send(payload);
    expect(res3.status).toBe(202);
    expect(res3.body.message).toContain('already processed');

    // Still exactly 1 record and 1 scheduled task
    expect(mockSupabase.store.size).toBe(1);
    expect(mockCloudTasksClient.scheduledTasks.length).toBe(1);
  });

  it('Requirement 8: Concurrent duplicate requests are handled safely', async () => {
    const concurrentPayload = {
      transaction_id: 'txn_concurrent_999',
      source_account: 'acc_source_concurrent',
      destination_account: 'acc_dest_concurrent',
      amount: 99.99,
      currency: 'EUR',
    };

    // Send 10 simultaneous requests
    const promises = Array.from({ length: 10 }).map(() =>
      request(app).post('/v1/webhooks/transactions').send(concurrentPayload)
    );

    const responses = await Promise.all(promises);

    // All requests should return 202 Accepted
    for (const res of responses) {
      expect(res.status).toBe(202);
    }

    // Only 1 record in database
    expect(mockSupabase.store.has('txn_concurrent_999')).toBe(true);
    const records = Array.from(mockSupabase.store.values()).filter(
      (r) => r.transaction_id === 'txn_concurrent_999'
    );
    expect(records.length).toBe(1);
  });
});

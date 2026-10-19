import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { mockSupabase } from './mocks/supabase.mock.js';
import { mockCloudTasksClient } from './mocks/cloud-tasks.mock.js';

describe('POST /v1/webhooks/transactions', () => {
  const validPayload = {
    transaction_id: 'txn_abc123def456',
    source_account: 'acc_user_789',
    destination_account: 'acc_merchant_456',
    amount: 1500,
    currency: 'INR',
  };

  it('Requirement 2: Valid webhook creates transaction and returns HTTP 202 Accepted', async () => {
    const response = await request(app)
      .post('/v1/webhooks/transactions')
      .send(validPayload);

    expect(response.status).toBe(202);
    expect(response.body).toHaveProperty('status', 'ACCEPTED');
    expect(response.body).toHaveProperty('transaction_id', validPayload.transaction_id);

    // Verify persisted in Supabase
    const saved = mockSupabase.store.get(validPayload.transaction_id);
    expect(saved).toBeDefined();
    expect(saved?.transaction_id).toBe(validPayload.transaction_id);
    expect(saved?.amount).toBe(1500);
    expect(saved?.currency).toBe('INR');
    expect(saved?.status).toBe('PROCESSING');
    expect(saved?.is_scheduled).toBe(true);
    expect(saved?.processed_at).toBeNull();
  });

  it('Requirement 3: Webhook response returns promptly without waiting for the 30-second background processing', async () => {
    const startTime = Date.now();
    const response = await request(app)
      .post('/v1/webhooks/transactions')
      .send({ ...validPayload, transaction_id: 'txn_speed_test_1' });
    const durationMs = Date.now() - startTime;

    expect(response.status).toBe(202);
    // Response should be prompt (<500ms)
    expect(durationMs).toBeLessThan(500);

    // Verify task was scheduled ~30s in the future
    expect(mockCloudTasksClient.scheduledTasks.length).toBe(1);
    const scheduledTask = mockCloudTasksClient.scheduledTasks[0];
    const scheduledSeconds = scheduledTask?.task?.scheduleTime?.seconds ?? 0;
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Should be scheduled approximately 30 seconds ahead
    const diff = scheduledSeconds - nowSeconds;
    expect(diff).toBeGreaterThanOrEqual(28);
    expect(diff).toBeLessThanOrEqual(32);
  });

  it('Requirement 4: Invalid webhook payloads are rejected with HTTP 400', async () => {
    // Missing transaction_id
    const resMissingId = await request(app)
      .post('/v1/webhooks/transactions')
      .send({
        source_account: 'acc_user_789',
        destination_account: 'acc_merchant_456',
        amount: 1500,
        currency: 'INR',
      });
    expect(resMissingId.status).toBe(400);
    expect(resMissingId.body.error).toBe('Validation Error');

    // Negative amount
    const resNegative = await request(app)
      .post('/v1/webhooks/transactions')
      .send({ ...validPayload, amount: -100 });
    expect(resNegative.status).toBe(400);

    // Zero amount
    const resZero = await request(app)
      .post('/v1/webhooks/transactions')
      .send({ ...validPayload, amount: 0 });
    expect(resZero.status).toBe(400);

    // Invalid decimal precision (e.g. 3 decimal places)
    const resDecimals = await request(app)
      .post('/v1/webhooks/transactions')
      .send({ ...validPayload, amount: 1500.123 });
    expect(resDecimals.status).toBe(400);

    // Invalid currency code length
    const resCurrency = await request(app)
      .post('/v1/webhooks/transactions')
      .send({ ...validPayload, currency: 'US' });
    expect(resCurrency.status).toBe(400);

    // Empty string account
    const resEmptyAccount = await request(app)
      .post('/v1/webhooks/transactions')
      .send({ ...validPayload, source_account: '   ' });
    expect(resEmptyAccount.status).toBe(400);
  });

  it('Requirement 11: Task creation failures are handled without falsely acknowledging unscheduled work', async () => {
    // Configure Cloud Tasks to fail
    mockCloudTasksClient.shouldFail = true;

    const response = await request(app)
      .post('/v1/webhooks/transactions')
      .send({ ...validPayload, transaction_id: 'txn_fail_scheduling_1' });

    // Should NOT return 202 Accepted
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('background task scheduling failed');

    // Transaction was persisted in database with is_scheduled = false
    const saved = mockSupabase.store.get('txn_fail_scheduling_1');
    expect(saved).toBeDefined();
    expect(saved?.is_scheduled).toBe(false);

    // When Cloud Tasks recovers and provider retries the webhook:
    mockCloudTasksClient.shouldFail = false;
    const retryResponse = await request(app)
      .post('/v1/webhooks/transactions')
      .send({ ...validPayload, transaction_id: 'txn_fail_scheduling_1' });

    // Retry successfully recovers and schedules the task
    expect(retryResponse.status).toBe(202);
    expect(saved?.is_scheduled).toBe(true);
    expect(mockCloudTasksClient.scheduledTasks.length).toBe(1);
  });
});

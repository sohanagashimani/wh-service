import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { mockSupabase } from './mocks/supabase.mock.js';

describe('GET /v1/transactions/:transaction_id', () => {
  it('Requirement 5: Existing transaction can be retrieved through status endpoint', async () => {
    // Populate transaction in PROCESSING state
    mockSupabase.store.set('txn_status_check_1', {
      transaction_id: 'txn_status_check_1',
      source_account: 'acc_user_1',
      destination_account: 'acc_merchant_1',
      amount: 2500.5,
      currency: 'USD',
      status: 'PROCESSING',
      is_scheduled: true,
      scheduled_at: new Date().toISOString(),
      created_at: '2026-10-19T10:00:00.000Z',
      processed_at: null,
    });

    const response = await request(app).get('/v1/transactions/txn_status_check_1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transaction_id: 'txn_status_check_1',
      source_account: 'acc_user_1',
      destination_account: 'acc_merchant_1',
      amount: 2500.5,
      currency: 'USD',
      status: 'PROCESSING',
      created_at: '2026-10-19T10:00:00.000Z',
      processed_at: null,
    });

    // Populate transaction in PROCESSED state
    const processedTimestamp = '2026-10-19T10:00:30.000Z';
    mockSupabase.store.set('txn_status_check_2', {
      transaction_id: 'txn_status_check_2',
      source_account: 'acc_user_2',
      destination_account: 'acc_merchant_2',
      amount: 100,
      currency: 'INR',
      status: 'PROCESSED',
      is_scheduled: true,
      scheduled_at: new Date().toISOString(),
      created_at: '2026-10-19T10:00:00.000Z',
      processed_at: processedTimestamp,
    });

    const processedResponse = await request(app).get('/v1/transactions/txn_status_check_2');

    expect(processedResponse.status).toBe(200);
    expect(processedResponse.body).toEqual({
      transaction_id: 'txn_status_check_2',
      source_account: 'acc_user_2',
      destination_account: 'acc_merchant_2',
      amount: 100,
      currency: 'INR',
      status: 'PROCESSED',
      created_at: '2026-10-19T10:00:00.000Z',
      processed_at: processedTimestamp,
    });
  });

  it('Requirement 6: Missing transaction returns HTTP 404', async () => {
    const response = await request(app).get('/v1/transactions/txn_non_existent');
    expect(response.status).toBe(404);
    expect(response.body).toHaveProperty('error');
    expect(response.body.error).toContain('not found');
  });
});

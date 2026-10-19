import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';

describe('GET / - Health Check', () => {
  it('returns HTTP 200 with status HEALTHY and dynamic ISO 8601 UTC timestamp', async () => {
    const beforeTime = Date.now() - 1000;
    const response = await request(app).get('/');
    const afterTime = Date.now() + 1000;

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'HEALTHY');
    expect(response.body).toHaveProperty('current_time');

    const timestamp = new Date(response.body.current_time).getTime();
    expect(Number.isNaN(timestamp)).toBe(false);
    expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(timestamp).toBeLessThanOrEqual(afterTime);
    expect(response.body.current_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

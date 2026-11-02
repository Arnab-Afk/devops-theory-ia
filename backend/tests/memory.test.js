const request = require('supertest');
const { createMemoryLimiter } = require('../src/limiters/memory');
const { createApp } = require('../src/app');
const { buildLimiters } = require('../src/rateLimit');

describe('memory limiter (single replica)', () => {
  test('allows exactly `limit` requests in a window, then blocks', async () => {
    let t = 1000;
    const limiter = createMemoryLimiter({ limit: 3, windowMs: 1000, now: () => t });
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await limiter.consume('a')).allowed);
    expect(results).toEqual([true, true, true, false, false]);
    limiter.close();
  });

  test('window slides: capacity comes back as old requests expire', async () => {
    let t = 0;
    const limiter = createMemoryLimiter({ limit: 2, windowMs: 1000, now: () => t });
    await limiter.consume('a'); // t=0
    t = 500;
    await limiter.consume('a'); // t=500
    expect((await limiter.consume('a')).allowed).toBe(false);
    t = 1001; // the t=0 request has left the window
    expect((await limiter.consume('a')).allowed).toBe(true);
    limiter.close();
  });

  test('two replicas with separate memory let through 2 x limit (the problem)', async () => {
    const replicaA = createMemoryLimiter({ limit: 5, windowMs: 10000 });
    const replicaB = createMemoryLimiter({ limit: 5, windowMs: 10000 });
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const replica = i % 2 === 0 ? replicaA : replicaB; // round-robin load balancer
      if ((await replica.consume('client')).allowed) allowed++;
    }
    expect(allowed).toBe(10);
    replicaA.close();
    replicaB.close();
  });
});

describe('HTTP API', () => {
  const config = {
    instance: 'test-pod',
    mode: 'memory',
    limit: 2,
    windowMs: 60000,
    failOpen: true,
    allowModeOverride: false,
  };
  const limiters = buildLimiters({ redis: null, ...config });
  const app = createApp({ config, limiters, redis: null });
  afterAll(() => limiters.memory.close());

  test('health reports the instance', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.instance).toBe('test-pod');
  });

  test('returns 429 with Retry-After and rate-limit headers once over the limit', async () => {
    const send = () => request(app).get('/api/resource').set('x-api-key', 'k1');
    expect((await send()).status).toBe(200);
    const second = await send();
    expect(second.status).toBe(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
    const third = await send();
    expect(third.status).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(third.headers['x-served-by']).toBe('test-pod');
  });

  test('limits are per client key', async () => {
    const res = await request(app).get('/api/resource').set('x-api-key', 'other-client');
    expect(res.status).toBe(200);
  });

  test('redis modes without Redis configured return a clear error', async () => {
    const strict = createApp({ config: { ...config, mode: 'redis' }, limiters, redis: null });
    const res = await request(strict).get('/api/resource');
    expect(res.status).toBe(500);
  });
});

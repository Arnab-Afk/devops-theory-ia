// Integration tests against a real Redis. Run with REDIS_URL set (CI starts a Redis service):
//   docker run -d -p 6379:6379 redis:7.4-alpine && REDIS_URL=redis://localhost:6379 npm test
const Redis = require('ioredis');
const request = require('supertest');
const { createRedisAtomicLimiter } = require('../src/limiters/redisAtomic');
const { createRedisNaiveLimiter } = require('../src/limiters/redisNaive');
const { createApp } = require('../src/app');
const { buildLimiters } = require('../src/rateLimit');

const REDIS_URL = process.env.REDIS_URL;
const describeRedis = REDIS_URL ? describe : describe.skip;

describeRedis('centralized limiting with Redis', () => {
  const REPLICAS = 3;
  const LIMIT = 20;
  const CONCURRENT = 100;
  let conns;

  beforeAll(() => {
    // One connection per simulated replica, like separate pods
    conns = Array.from({ length: REPLICAS }, () => new Redis(REDIS_URL));
  });
  afterAll(() => Promise.all(conns.map((c) => c.quit())));

  const uniqueKey = (name) => `test:${name}:${Date.now()}:${Math.random()}`;

  test(`atomic: ${CONCURRENT} concurrent requests across ${REPLICAS} replicas -> exactly ${LIMIT} allowed`, async () => {
    const replicas = conns.map((redis, i) =>
      createRedisAtomicLimiter({ redis, limit: LIMIT, windowMs: 10000, instance: `pod-${i}` })
    );
    const key = uniqueKey('atomic');
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) => replicas[i % REPLICAS].consume(key))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(LIMIT);
    const blocked = results.filter((r) => !r.allowed);
    expect(blocked).toHaveLength(CONCURRENT - LIMIT);
    expect(blocked.every((r) => r.retryAfterMs > 0)).toBe(true);
  });

  test('atomic: window slides and capacity returns', async () => {
    const limiter = createRedisAtomicLimiter({ redis: conns[0], limit: 2, windowMs: 300, instance: 'pod-0' });
    const key = uniqueKey('slide');
    expect((await limiter.consume(key)).allowed).toBe(true);
    expect((await limiter.consume(key)).allowed).toBe(true);
    expect((await limiter.consume(key)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 350));
    expect((await limiter.consume(key)).allowed).toBe(true);
  });

  test('naive check-then-record: shared count, but the race lets extra requests through', async () => {
    const replicas = conns.map((redis) => createRedisNaiveLimiter({ redis, limit: LIMIT, windowMs: 10000 }));
    const key = uniqueKey('naive');
    // Each request: check, do 10 ms of work, then record, like the middleware does
    const handle = async (i) => {
      const r = await replicas[i % REPLICAS].consume(key);
      if (r.allowed) {
        await new Promise((res) => setTimeout(res, 10));
        await r.commit();
      }
      return r;
    };
    const results = await Promise.all(Array.from({ length: CONCURRENT }, (_, i) => handle(i)));
    const allowed = results.filter((r) => r.allowed).length;
    console.log(`naive limiter allowed ${allowed}/${CONCURRENT} (limit ${LIMIT})`);
    // Never fewer than the limit; under concurrency typically far more
    expect(allowed).toBeGreaterThanOrEqual(LIMIT);
  });

  test('Redis down: fail-open serves the request, fail-closed returns 503', async () => {
    // Stand-in for a Redis that is down: every command fails like a refused connection
    const down = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const dead = {
      get: down,
      incr: down,
      ping: down,
      defineCommand(name) {
        this[name] = down;
      },
    };
    const base = { instance: 't', mode: 'redis', limit: 5, windowMs: 1000, allowModeOverride: false };
    const limiters = buildLimiters({ redis: dead, ...base });

    const open = await request(createApp({ config: { ...base, failOpen: true }, limiters, redis: dead })).get('/api/resource');
    expect(open.status).toBe(200);
    expect(open.headers['x-ratelimit-degraded']).toBe('true');

    const closed = await request(createApp({ config: { ...base, failOpen: false }, limiters, redis: dead })).get('/api/resource');
    expect(closed.status).toBe(503);

    limiters.memory.close();
  });
});

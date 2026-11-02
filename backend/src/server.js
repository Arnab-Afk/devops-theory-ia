const Redis = require('ioredis');
const config = require('./config');
const { createApp } = require('./app');
const { buildLimiters } = require('./rateLimit');

const redis = config.redisUrl
  ? new Redis(config.redisUrl, {
      // Fail fast instead of queueing requests while Redis is down, so fail-open/closed kicks in quickly
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
    })
  : null;

if (redis) {
  redis.on('ready', () => console.log('Connected to Redis'));
  redis.on('error', (err) => console.error('Redis error:', err.message));
}

const limiters = buildLimiters({ redis, ...config });
const app = createApp({ config, limiters, redis });

const server = app.listen(config.port, () =>
  console.log(
    `[${config.instance}] listening on :${config.port} mode=${config.mode} limit=${config.limit}/${config.windowMs}ms failOpen=${config.failOpen}`
  )
);

// Kubernetes sends SIGTERM on rollout/scale-down: finish in-flight requests, then close Redis
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close(() => {
    if (redis) redis.quit();
    process.exit(0);
  });
});

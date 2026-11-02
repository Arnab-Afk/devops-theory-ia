const express = require('express');
const { rateLimit } = require('./rateLimit');

function createApp({ config, limiters, redis }) {
  const app = express();
  // Behind nginx / a Kubernetes ingress: use X-Forwarded-For for the client IP
  app.set('trust proxy', true);

  // Every response says which replica answered, so the demo can show requests spreading across pods
  app.use((req, res, next) => {
    res.set('X-Served-By', config.instance);
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', instance: config.instance }));

  app.get('/ready', async (req, res) => {
    if (!redis) return res.json({ status: 'ready', redis: 'not configured' });
    try {
      await redis.ping();
      res.json({ status: 'ready', redis: 'ok' });
    } catch {
      // Still ready when failing open: the API keeps serving without Redis
      res.status(config.failOpen ? 200 : 503).json({ status: config.failOpen ? 'degraded' : 'not ready', redis: 'down' });
    }
  });

  app.get('/api/config', (req, res) =>
    res.json({
      instance: config.instance,
      mode: config.mode,
      limit: config.limit,
      windowMs: config.windowMs,
      failOpen: config.failOpen,
      modeOverride: config.allowModeOverride,
    })
  );

  // The protected API. workMs simulates the real work behind it (a database call, another service)
  app.get('/api/resource', rateLimit({ limiters, ...config }), async (req, res) => {
    if (config.workMs) await new Promise((r) => setTimeout(r, config.workMs));
    res.json({ ok: true, instance: config.instance, at: new Date().toISOString() });
  });

  return app;
}

module.exports = { createApp };

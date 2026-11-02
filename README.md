# devops-theory-ia

**Distributed Rate Limiting for Microservices with Redis**

An API runs as several replicas behind a round-robin load balancer. Each client may make
**20 requests per 10 seconds**. The same limiter is implemented three ways and hit with the same
concurrent burst, to show why rate limiting has to be centralized, and why it has to be atomic.

| Mode | How it counts | 300 concurrent requests, 3 replicas | Verdict |
|---|---|---|---|
| `memory` | each replica keeps its own counter | **60 allowed** (20 per replica) | limit × replicas |
| `redis-naive` | shared Redis counter: check, handle, then `INCR` | **131–187 allowed** | race condition |
| `redis` | shared sliding window in one atomic Lua script | **20 allowed** | exact |

With 6 replicas on Kubernetes, `memory` lets through **120** (6 × 20) while `redis` still allows exactly **20**.

```
                      ┌──────────────── Docker Compose / Kubernetes ────────────────┐
 client / burst.js ─► │ nginx gateway ──round robin──► api replica 1 ─┐             │
 browser dashboard    │  (dashboard)               ├─► api replica 2 ─┼─► Redis     │
                      │                            └─► api replica N ─┘  (counters) │
                      └─────────────────────────────────────────────────────────────┘
```

## Quick start (Docker Compose)

```bash
docker compose up -d --build              # Redis + 3 API replicas + nginx gateway
open http://localhost:8080                # live dashboard: fire a burst, compare the modes
node scripts/burst.js                     # 100 truly concurrent requests against every mode
node scripts/burst.js --requests 300 --mode redis
docker compose up -d --scale api=5        # more replicas: memory mode allows 5 x the limit
docker compose down
```

`scripts/burst.js` needs Node 18+ and has no dependencies. Add `--check` to make it exit non-zero
unless every mode behaves as described above (CI uses this).

## Kubernetes

```bash
docker build -t rate-limit-api:latest backend
docker build -f gateway/Dockerfile -t rate-limit-gateway:latest .
k3d cluster create ratelimit -p "8181:80@loadbalancer"          # or any cluster
k3d image import -c ratelimit rate-limit-api:latest rate-limit-gateway:latest
kubectl apply -k k8s
node scripts/burst.js --url http://localhost:8181
kubectl -n ratelimit patch hpa api -p '{"spec":{"minReplicas":6}}'   # scale out, burst again
```

On other clusters, point the `images:` entries in `k8s/kustomization.yaml` at the GHCR images
the pipeline publishes (`ghcr.io/arnab-afk/devops-theory-ia/api`, `.../gateway`), or use
`kubectl -n ratelimit port-forward svc/gateway 8181:80` if there is no LoadBalancer.

## Tests

```bash
cd backend && npm install
npm test                                              # unit tests
REDIS_URL=redis://localhost:6379 npm test             # + Redis integration tests
```

The Redis tests simulate 3 replicas with separate connections and fire 100 concurrent requests:
the atomic limiter must allow exactly 20, the naive one lets far more through, and a Redis outage
must fail open (or return 503 when `RATE_LIMIT_FAIL_OPEN=false`).

## CI/CD (`.github/workflows/ci.yml`)

1. **test**: unit tests and Redis integration tests against a Redis service container
2. **e2e**: `docker compose up` (3 replicas), then `burst.js --check`
3. **images**: on `main`, build and push the API and gateway images to GHCR, tagged with the commit SHA

## API

| Path | Notes |
|---|---|
| `GET /api/resource` | the rate-limited endpoint |
| `GET /api/config` | active mode, limit, window |
| `GET /health`, `GET /ready` | liveness; readiness including Redis |

Every response carries `X-Served-By` (replica/pod) and `X-RateLimit-Mode`, `X-RateLimit-Limit`,
`X-RateLimit-Remaining`. Blocked requests get `429 Too Many Requests` with `Retry-After`.
The client is identified by the `X-API-Key` header, or its IP otherwise.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_MODE` | `redis` | `memory`, `redis-naive` or `redis` |
| `RATE_LIMIT` / `RATE_LIMIT_WINDOW_MS` | `20` / `10000` | requests allowed per client per window |
| `RATE_LIMIT_FAIL_OPEN` | `true` | Redis down: serve anyway (`true`) or return 503 (`false`) |
| `ALLOW_MODE_OVERRIDE` | `false` (`true` in the demo configs) | lets a request pick its mode with `X-RateLimit-Mode` |
| `WORK_MS` | `20` | simulated work per request (like a database call) |
| `REDIS_URL` | | e.g. `redis://redis:6379` |

## Repository layout

```
backend/src/limiters/   memory.js, redisNaive.js, redisAtomic.js (Lua sliding window)
backend/src/            rateLimit.js (middleware, fail-open/closed), app.js, server.js
backend/tests/          unit tests, Redis concurrency tests
gateway/                nginx round-robin load balancer (templated for Compose and Kubernetes)
dashboard/index.html    live demo page
scripts/burst.js        concurrent burst + results table (+ --check for CI)
k8s/                    namespace, Redis, API (3 replicas), HPA (3-6), gateway, Kustomize config
docs/DEMO.md            live demo script
docs/REPORT.md          theory report and results
```

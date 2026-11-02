# Live demo (about 10 minutes)

**Story:** the API runs as several replicas. A limit kept in each replica's memory is multiplied by
the number of replicas. Moving the counter to Redis makes it shared, but only an atomic update makes
it correct under concurrent requests.

## Before the demo

```bash
docker compose up -d --build
node scripts/burst.js --requests 50          # warm-up; every mode should answer
```

Open three terminals in the repo root and a browser tab on http://localhost:8080.

| Terminal | Command |
|---|---|
| A: replicas | `docker compose ps` |
| B: bursts | `node scripts/burst.js ...` |
| C: Redis | `docker compose exec redis redis-cli monitor \| grep -E "evalsha\|\"get\"\|\"incr\""` |

## Script

| # | Show | Say |
|---|---|---|
| 1 | `docker compose ps`: 3 `api` replicas, `redis`, `gateway` | "Stateless API replicas behind nginx round robin, one shared Redis." |
| 2 | `curl -si localhost:8080/api/resource \| grep -i x-served-by` a few times | "Consecutive requests from the same client land on different replicas." |
| 3 | Dashboard: **Fire burst** (60 requests) | "Same client, same burst, three ways of counting. Limit is 20 per 10 seconds." |
| 4 | Left column: 60 allowed, 20 per replica | "Each replica only sees a third of the traffic, so the client gets 3 times the limit." |
| 5 | `docker compose up -d --scale api=5`, then `node scripts/burst.js --mode memory` | "Add replicas and the effective limit grows with them: 100 allowed. Autoscaling silently changes the limit." |
| 6 | `node scripts/burst.js --requests 300` | "Redis non-atomic: everyone shares the counter, yet 100+ get through." |
| 7 | Point at `redisNaive.js` | "Check, handle, then INCR: every request in flight reads the same old count. Classic check-then-act race." |
| 8 | Same table, `redis` row: exactly 20; terminal C shows `evalsha` from every replica | "One Lua script trims, counts and adds atomically, using Redis's own clock. Exactly 20, on 3 or 5 replicas." |
| 9 | `docker compose stop redis`, then `curl -si localhost:8080/api/resource \| grep -iE "HTTP\|degraded"` | "Redis is now a dependency. We fail open: traffic keeps flowing, marked degraded." |
| 10 | `docker compose start redis`, `node scripts/burst.js --mode redis` | "When it returns, limiting is exact again." |
| 11 | (optional) `.github/workflows/ci.yml` | "CI runs the same burst with `--check` on every push." |

Reset with `docker compose up -d --scale api=3`.

## Kubernetes variant

```bash
kubectl apply -k k8s
kubectl -n ratelimit get pods -l app=api -w                         # terminal A
node scripts/burst.js --url http://localhost:8181                   # terminal B
kubectl -n ratelimit patch hpa api -p '{"spec":{"minReplicas":6}}'  # scale out
# wait for 6 Running pods, burst again: memory 120 (6 x 20), redis still 20
kubectl -n ratelimit patch hpa api -p '{"spec":{"minReplicas":3}}'
kubectl -n ratelimit exec deploy/redis -- redis-cli monitor         # terminal C
```

## Notes

- The dashboard runs in a browser, which opens only about 6 connections per site, so its bursts
  are only partly concurrent and the `redis-naive` race looks small there. Use `burst.js` for step 6.
- Each burst uses a fresh client key, so runs never share a window. Tick **Same client as last burst**
  in the dashboard to show that a client stays blocked for the rest of its window.

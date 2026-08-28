# Health endpoints

The API exposes unauthenticated operational probes. They require no
authentication and are not subject to application business authorization
checks, so load balancers and monitoring systems can probe them without a
session:

- `GET /health` and `GET /health/live` are **liveness** probes. They return
  `200` when the API process can accept requests and do not contact external
  services.
- `GET /health/ready` is a **readiness** probe. It returns `200` with
  `{ "status": "ok", "checks": ... }` only when the database and Stellar
  Horizon are available. It returns `503` with `status: "not_ready"` when a
  required dependency is unavailable, so a load balancer can remove the
  instance from service.

## Response shapes

Liveness:

```json
{ "status": "ok", "timestamp": "2026-08-27T12:00:00.000Z" }
```

Readiness (`200` when ready, `503` when not):

```json
{
  "status": "ok",
  "checks": { "database": "up", "stellar": "up", "anchor": "disabled" },
  "timestamp": "2026-08-27T12:00:00.000Z"
}
```

Each dependency reports one of `up`, `down`, or `disabled`. A `down` status on
any required check makes the whole response `not_ready` with HTTP `503`. The
`anchor` check is reported `disabled` when no anchor is configured.

## What readiness verifies

- **Database** — Prisma runs `SELECT 1` against the shared client.
- **Stellar** — the configured Horizon endpoint answers a read-only fee-stats
  request (the same `getFeeStats()` read the application uses, so there is no
  second Stellar configuration path).
- **Anchor** — the configured anchor's `stellar.toml` is reachable (only when
  `ANCHOR_HOME_DOMAIN` is set).

## Bounds and safety

Readiness results are cached for five seconds and each dependency check has a
1.5-second timeout, so an unavailable upstream never hangs a probe. Responses
contain only dependency state and never include connection strings, URLs,
credentials, or upstream error details — the underlying error text is
swallowed before it can reach the response.

**Required runtime configuration is validated before readiness ever serves.**
`src/config.ts` validates the full configuration at process start and exits
non-zero when anything required is missing or invalid (including the
`STELLAR_NETWORK`/`HORIZON_URL` pairing). A running instance therefore always
has valid configuration; readiness then verifies the live dependencies.

## Scope

The API and worker are separate processes. These endpoints report API process
and API dependency health only; they do not assert that the background worker
is running. Monitor the worker process independently using its process
supervisor, logs, and job metrics. A healthy `/health/ready` response therefore
does not mean settlement submission or reconciliation jobs are being consumed.

# Health endpoints

The API exposes unauthenticated operational probes:

- `GET /health` and `GET /health/live` are liveness probes. They return `200`
  when the API process can accept requests and do not contact external services.
- `GET /health/ready` is a readiness probe. It returns `200` with
  `{ "status": "ok", "checks": ... }` only when the database and Stellar
  Horizon are available. It returns `503` with `status: "not_ready"` when a
  required dependency is unavailable.

Readiness results are cached for five seconds and each dependency check has a
1.5-second timeout. Anchor readiness is checked only when
`ANCHOR_HOME_DOMAIN` is explicitly configured; otherwise its check is reported
as `disabled`. Responses contain only dependency state and never include
connection strings, URLs, credentials, or upstream error details.

The API and worker are separate processes. These endpoints report API process
and API dependency health only; they do not assert that the background worker
is running. Monitor the worker process independently using its process
supervisor, logs, and job metrics. A healthy `/health/ready` response therefore
does not mean settlement submission or reconciliation jobs are being consumed.

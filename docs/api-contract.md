# Mergepay API contract reference

The canonical client contract lives in `mergepay-web/src/lib/types.ts`. This file
is the local reference for the parts of the contract that are defined by this
repository, so a change here can be mirrored there in one step.

Keep this file in sync whenever a response shape, status vocabulary, error code,
or query convention changes.

---

## Error envelope

Every error — validation, authorization, rate limiting, upstream — uses one shape:

```json
{
  "error": "NOT_FOUND",
  "message": "Settlement not found",
  "statusCode": 404,
  "details": { "…": "optional, structured" },
  "requestId": "01J…"
}
```

`error` is a stable machine-readable code from `ErrorCode` in
[../src/lib/errors.ts](../src/lib/errors.ts). Codes worth calling out:

| Code | Status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Request failed Zod validation; `details` lists the offending fields |
| `INVALID_CURSOR` | 400 | Pagination cursor was not produced by this API |
| `INTENT_EXPIRED` | 400 | The unsigned transaction's signing window has closed — request a new one |
| `XDR_MISMATCH` | 400 | The signed envelope does not match the intent it was built for |
| `XDR_MALFORMED` | 400 | The envelope could not be parsed at all |
| `INVALID_IDEMPOTENCY_KEY` | 400 | `Idempotency-Key` is outside 1–255 characters of `A–Z a–z 0–9 - _ . :` |
| `MISSING_IDEMPOTENCY_KEY` | 400 | The route requires an `Idempotency-Key` header and none was sent |
| `IDEMPOTENCY_CONFLICT` | 409 | The key was already used with a different payload |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | The first request with this key is still running; retry shortly |
| `UNAUTHORIZED` | 401 | Missing or invalid session |
| `FORBIDDEN` | 403 | Authenticated, but not permitted on this resource |
| `NOT_FOUND` | 404 | The resource does not exist |
| `RATE_LIMITED` | 429 | Per-route budget exhausted; `details.retryAfterSeconds` when available |
| `UPSTREAM_ERROR` | 502 | Horizon or an anchor failed |

`404` versus `403` is deliberate and consistent: a resource that does not exist
is `404`; one that exists but is not the caller's is `403`. Clients need to
distinguish "gone" from "not yours" to render a useful state, and the difference
leaks only the existence of an opaque identifier — never any content.

---

## Pagination

Applies to `GET /groups`, `/groups/:id/expenses`, `/groups/:id/ledger`,
`/groups/:id/treasury/history`, `/anchors/sessions`, and `/history`. Defined in
[../src/lib/pagination.ts](../src/lib/pagination.ts).

### Query parameters

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | `50` | Out of range → `VALIDATION_ERROR` (never silently clamped) |
| `cursor` | opaque string | — | From a previous response's `meta.nextCursor`; malformed → `INVALID_CURSOR` |
| `order` | `"desc"` \| `"asc"` | `"desc"` | Applies to the `(createdAt, id)` ordering |

### Response metadata

```ts
interface PageMeta {
  nextCursor: string | null;  // null when there is no further page
  hasMore: boolean;
  limit: number;              // the effective page size
  order: "asc" | "desc";
}
```

Guarantees:

- **Deterministic ordering.** Rows are ordered by the pair `(createdAt, id)`, so
  records sharing a timestamp have a defined order and can never appear on two
  pages or be skipped between them.
- **Bounded reads.** Each query fetches `limit + 1` rows — the page plus one
  lookahead row to compute `hasMore` — so no endpoint loads a full result set.
- **Cursors carry no authority.** A cursor contains only ordering coordinates,
  never a group id, user id, or permission. Scope comes from each query's own
  filter plus its membership check, so a cursor from one resource replayed
  against another can only move a page boundary inside data the caller may
  already read.

`GET /history` paginates two resources independently: `cursor` walks the expense
stream, `settlementCursor` walks the settlement stream, with metadata in `meta`
and `settlementMeta` respectively.

---

## Idempotency

Defined in [../src/services/idempotency.ts](../src/services/idempotency.ts).
Mobile networks and wallet callbacks retry after timeouts, so every
state-changing settlement request can be replayed safely.

### The header

| | |
| --- | --- |
| Header | `Idempotency-Key` |
| Length | 1–255 characters |
| Charset | `A–Z`, `a–z`, `0–9`, `-`, `_`, `.`, `:` |
| Validation | Zod, before any database read — out of bounds is `INVALID_IDEMPOTENCY_KEY` (400) |

| Endpoint | Key |
| --- | --- |
| `POST /expenses/:id/settle` | optional, honoured when sent |
| `POST /groups/:id/settlements` | optional, honoured when sent |
| `POST /settlements/:id/confirm` | **required** — missing is `MISSING_IDEMPOTENCY_KEY` (400) |
| `POST /groups/:id/treasury/{deposit,withdraw}`, `POST /treasury-transactions/:id/confirm` | optional, honoured when sent |

Submission requires a key because it is the request that ends in money moving:
a retry that slipped through unguarded could mean a second on-chain payment.

### Semantics

A key is stored against `(authenticated user, operation scope, key)` together
with a hash of the request's intent (scope, resource id, body).

- **Replay** — same user, same key, equivalent payload → the **original**
  response is returned verbatim. No second settlement record is created and no
  second envelope is handed to the worker for Horizon submission.
- **Different payload** — same user and key, different body → `409
  IDEMPOTENCY_CONFLICT`. The first request's result is untouched.
- **Different user** — a key is invisible outside the account that used it.
  Another user sending the same string starts a fresh request; it never replays
  and never conflicts.
- **Different endpoint** — the scope is part of the identity, so the same string
  on an unrelated route is a separate key.
- **Concurrency** — the reservation row is written before the guarded operation
  runs, and the unique constraint serializes racing retries. The loser gets
  `409 IDEMPOTENCY_IN_PROGRESS` rather than a second execution, so concurrent
  requests produce exactly one durable outcome.
- **Failure** — the guarded operation runs inside a database transaction, so a
  failure rolls back completely and the key is marked `failed`. The same key may
  then be retried and will run exactly once more. A settlement is never left
  looking complete without a confirmed transaction: the request path only
  records a signed envelope, and the status only advances past `submitted` once
  the worker has a Horizon result.
- **Retention** — keys replay for 24 hours, then are swept.

Signed XDR validation happens **before** the key's operation begins, so an
invalid envelope is never recorded as an idempotent success — every retry with a
bad envelope gets the same fresh `XDR_MISMATCH`.

---

## Transaction intents and expiration

Defined in [../src/lib/time-bounds.ts](../src/lib/time-bounds.ts).

Endpoints that return an unsigned XDR (`POST /expenses/:id/settle`,
`POST /groups/:id/settlements`, `POST /groups/:id/treasury/deposit`,
`POST /groups/:id/treasury/withdraw`) include:

```ts
{
  xdr: string;                 // unsigned envelope for the wallet to sign
  networkPassphrase: string;
  expiresAt: string;           // ISO 8601, server-controlled
  expiresInSeconds: number;
}
```

- The deadline is derived from the **server** clock and is also set as the
  transaction's `maxTime`, so the stored intent and the on-chain envelope
  describe the same moment.
- `validitySeconds` (optional, 30–300) requests a **shorter** window. A client
  can never extend one and never supplies an absolute timestamp; out-of-range
  values are a `VALIDATION_ERROR`.
- `POST /settlements/:id/confirm` and `POST /treasury-transactions/:id/confirm`
  reject a lapsed intent with `INTENT_EXPIRED`. Submission additionally validates
  the signed envelope's own time bounds against the stored intent — an unbounded
  envelope, or one valid longer than its intent, is an `XDR_MISMATCH`.
- Comparisons allow a bounded **30-second** clock-skew tolerance.
- No expired transaction is ever submitted to Horizon or an anchor. The worker
  marks such a settlement `expired` and releases its expense share.

`Settlement` and `TreasuryTransaction` payloads both carry
`expiresAt: string | null` (null on rows predating expiration tracking).

### Signed XDR validation

Defined in [../src/services/settlement-xdr.ts](../src/services/settlement-xdr.ts)
and [../src/services/stellar.ts](../src/services/stellar.ts).

`POST /settlements/:id/confirm` loads the settlement's **stored** intent — never
anything the client sent alongside the envelope — and validates the signed XDR
against it before the envelope is persisted and before anything reaches Horizon.
The worker repeats the same check at submission time.

Checked, in order:

| Property | Rejected when |
| --- | --- |
| Envelope | Unparseable, or a fee-bump wrapper (`XDR_MALFORMED` / `XDR_MISMATCH`) |
| Validity window | No expiry, valid longer than the intent, already lapsed, or not yet valid |
| Transaction source | Not the settlement's payer |
| Operation count | Anything other than exactly one operation |
| Fee | Below the network minimum or above the fee the API built (per operation) |
| Operation type | Not a payment |
| Operation source | Overridden to an account other than the payer |
| Destination | Not the settlement's recipient |
| Asset | Different code, or the same code with a different issuer |
| Amount | Differs at 7-decimal precision |
| Memo | Not the settlement's own short code |
| Signature | Missing, or not verifiable against the source account for the configured network passphrase |

A mismatch is a `400` with a stable code (`XDR_MISMATCH`, `XDR_MALFORMED`, or
`INTENT_EXPIRED`) and a message naming the field that diverged. The signed
envelope, its signatures, and any key material are never included in the
response or in logs. A rejected transaction is never submitted and never
advances the settlement's status — the settlement stays awaiting a signature and
the wallet can sign the correct envelope instead.

---

## `GET /settlements/:id/status`

The single source of truth for a settlement's state after creating or signing it.
Defined in [../src/services/settlement-status.ts](../src/services/settlement-status.ts).

**Authentication:** required. **Authorization:** any member of the settlement's
group, via the same `requireMembership` helper the mutating routes use.

### Path parameter

`:id` accepts either the settlement's cuid or its human-facing `shortCode` (the
value that appears in the payment memo). Both are unique. Anything outside
`[A-Za-z0-9_-]{4,64}` is a `VALIDATION_ERROR` before any database read.

### Query parameters

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `refresh` | `"true"` \| `"false"` | `"true"` | Whether to consult Horizon for on-chain confirmation |

### Response

```ts
interface SettlementStatusResponse {
  settlement: Settlement;              // the standard serialized settlement
  status: SettlementStatus;
  terminal: boolean;                   // whether `status` can still change
  onChain: {
    checked: boolean;                  // a Horizon lookup ran and answered in time
    found: boolean;                    // Horizon has a record of the transaction
    successful: boolean | null;        // Horizon's own flag; null if not found
    transactionHash: string | null;
  };
  failure: { reason: string } | null;  // scrubbed; no upstream text or stack
  expiresAt: string | null;            // ISO 8601
  expiresInSeconds: number | null;     // negative once lapsed
  createdAt: string;                   // ISO 8601
  updatedAt: string;                   // ISO 8601
  checkedAt: string;                   // ISO 8601, when this answer was computed
}
```

### Status values

```ts
type SettlementStatus =
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "failed"
  | "expired";
```

| Status | Terminal | Meaning | Client action |
| --- | --- | --- | --- |
| `awaiting_signature` | no | Unsigned XDR issued; no signed envelope returned yet | Sign it before `expiresAt` |
| `submitted` | no | A signed envelope was accepted and is being submitted; not yet confirmed on-chain | Keep polling |
| `confirmed` | yes | The payment succeeded on-chain | Done |
| `failed` | yes | Submission was rejected, or the transaction failed on-chain | Read `failure.reason` |
| `expired` | yes | The signing window closed before submission | Create a new settlement |

An unrecognised internal status maps to `awaiting_signature` — conservative, and
never reported as paid.

### Pending is not confirmed

A transaction hash Horizon does not yet know about is the ordinary state for the
first seconds after submission, because Horizon only sees a transaction once it
is in a closed ledger. That case is reported as `onChain.found: false` with
status `submitted`. Only an explicitly successful Horizon record advances the
status to `confirmed`, and only an explicitly unsuccessful one to `failed`.

The Horizon lookup runs only when it could change the answer (there is a hash and
the status is not already terminal), is bounded by a 2.5s timeout, and degrades
to `onChain.checked: false` rather than failing the request if Horizon is slow or
erroring.

### Never returned

Signed or unsigned XDRs, private keys, anchor or session tokens, provider
credentials, upstream error text, and stack traces. `failure.reason` is limited
to the short, already-scrubbed message the worker recorded.

---

## Rate limiting

Every route is covered by a global budget; SEP-10 authentication, signed
submission, and anchor routes each get their own bucket. See the table in
[../README.md](../README.md#rate-limiting) and the policy definitions in
[../src/lib/rate-limit.ts](../src/lib/rate-limit.ts).

A 429 uses the standard error envelope with `error: "RATE_LIMITED"` and, where
available, `details.retryAfterSeconds`, alongside the usual `Retry-After` and
`X-RateLimit-*` headers. It reveals nothing about the caller's identity or
whether a wallet account is known to the API.

---

## Health endpoints

Operational probes for deployments and load balancers. They require no
authentication and are not subject to application business authorization — a
monitoring probe must work without a session. See also
[../HEALTH.md](../HEALTH.md) for the deployment-facing view.

| Endpoint | Type | Behavior |
| --- | --- | --- |
| `GET /health` · `GET /health/live` | Liveness | `200` with `{ "status": "ok", "timestamp": "…" }` while the process can accept requests. Contacts nothing external. |
| `GET /health/ready` | Readiness | `200` with `{ "status": "ok", "checks": {…} }` when every required dependency is available; `503` with `{ "status": "not_ready", "checks": {…} }` otherwise. |

### Readiness checks

`GET /health/ready` verifies the dependencies the API needs to submit and
inspect transactions, using only read-only requests — never a state-changing
call:

| Check | What it verifies | How |
| --- | --- | --- |
| `stellar` | The configured Horizon endpoint answers a read-only fee-stats request, proving the Stellar network configuration is usable end to end | `getFeeStats()` in `src/services/network.ts` — the shared Horizon client built from `config.HORIZON_URL`, no duplicated configuration |
| `database` | Prisma can run `SELECT 1` | Read-only query on the shared Prisma client |
| `anchor` | The configured anchor's `stellar.toml` is reachable | Read-only request; reported `disabled` when no anchor is configured |

Each check has its own 1.5-second timeout and results are cached for five
seconds, so an unavailable upstream never hangs a probe or thrashes Horizon.
A `down` status on any required check makes the whole response `not_ready`
with HTTP `503`, which lets a load balancer drain the instance.

Responses contain only the status vocabulary (`up`/`down`/`disabled`,
`ok`/`not_ready`) and a timestamp — never connection strings, Horizon URLs,
credentials, tokens, or upstream error text.

**Invalid Stellar configuration fails fast, before the API can report ready.**
`STELLAR_NETWORK` and `HORIZON_URL` are validated together at process start in
`src/config.ts`: a testnet URL with a `public` network (or vice versa) exits the
process with a clear error instead of serving a readiness endpoint that could
only ever report a broken dependency.

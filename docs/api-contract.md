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

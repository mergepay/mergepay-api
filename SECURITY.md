# Security Policy

Mergepay API is **testnet-only, pre-audit** software. It builds and validates
Stellar transactions but never holds user private keys. Please read this before
reporting a vulnerability.

## Supported versions

| Version | Supported |
|---|---|
| `main` (latest) | ✅ Only supported branch |
| Any tag < `v0.1.0` | ❌ |

`main` is the only branch that receives security fixes. There is no long-term
support branch.

## Audit status

The backend is **unaudited**. It has not undergone a third-party security review.
Do not run it against Stellar mainnet with real funds without your own review and
hardening. Use at your own risk.

## In scope

Vulnerabilities in this repository's own attack surface, in particular:

- **Signed-XDR validation bypass** in `POST /settlements/:id/confirm` — a signed
  envelope with mismatched source, payment op, destination, asset, amount, or
  memo being accepted instead of rejected with `xdr_mismatch`.
- **SEP-10 challenge/verify bypass or replay** — forging or replaying a challenge
  to obtain a session for an account you don't control.
- **Anchor webhook signature bypass** — accepting a `POST /anchors/webhook` with a
  missing, forged, or replayed `x-anchor-signature`.
- **JWT forgery / weak `JWT_SECRET` handling / session fixation.**
- **Treasury multisig signer-count bypass** — submitting a treasury withdrawal
  with fewer signatures than `treasuryRequiredSigners`.
- **Idempotency-key logic** allowing a double-submission to Horizon.
- **Auth / membership check bypass** on any group or expense route (acting on a
  group or expense you are not a member of, or performing an admin-only action
  without the role).

## Out of scope

- Denial of service via unlimited request volume — the API is not yet rate
  limited; this is tracked separately, not a reportable vulnerability.
- Vulnerabilities in third-party anchors, wallets, Horizon, or the Stellar
  network itself.
- Issues that require a compromised maintainer machine or leaked `.env`.

## Reporting a vulnerability

**Do not open a public GitHub issue for a live vulnerability.**

Report privately by email to **adesanyafuhad5@gmail.com**. If you prefer, you can
also use GitHub's private **[Report a vulnerability](https://github.com/mergepay/mergepay-api/security/advisories/new)**
advisory flow. Include: affected endpoint/file, a description of the issue, and a
reproduction (request sequence, XDR, or test) if you have one.

This is a solo-maintained project, so response times are best-effort:

| Stage | Target |
|---|---|
| Acknowledge receipt | within 72 hours |
| Initial assessment | within 7 days |
| Fix or mitigation plan | depends on severity and scope |

## Disclosure policy

Coordinated disclosure. Please give the maintainer a reasonable window to ship a
fix before disclosing publicly. No fixed embargo length is committed to; timing
is agreed case by case.

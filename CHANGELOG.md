# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Verified

- **Debt simplification test coverage (#685)** — Comprehensive test suites already verify greedy debt-simplification algorithm across circular debts (balanced/uneven rings, bidirectional netting), zero-balance members, unequal shares, and multi-asset segregation. 61 tests across `tests/settlement.test.ts` (lines 287-454) and `tests/multi-asset-settlement.test.ts` enforce mathematical completeness and (n-1) transfer bound.
- **Treasury multisig implementation (#686)** — Unsigned XDR proposal storage, live-weight signer verification from Horizon, cryptographic signature validation, threshold-based auto-submission fully implemented in `src/routes/treasury-proposals.ts` (~208 lines) and `src/services/treasury-signatures.ts` (~473 lines). Admin-only signers enforced, unauthorized/invalid signatures rejected, 44+ integration tests covering proposal lifecycle.

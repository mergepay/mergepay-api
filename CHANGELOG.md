# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Verified

- **Debt simplification test coverage (#685)** — Comprehensive test suites already verify greedy debt-simplification algorithm across circular debts (balanced/uneven rings, bidirectional netting), zero-balance members, unequal shares, and multi-asset segregation. 61 tests across `tests/settlement.test.ts` (lines 287-454) and `tests/multi-asset-settlement.test.ts` enforce mathematical completeness and (n-1) transfer bound.

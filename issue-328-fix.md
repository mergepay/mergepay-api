# Issue #328 — Centralized audit logging for group actions and state changes

## Summary
Implement a shared audit logging helper and middleware that records every relevant group action and state change securely in the database. This issue focuses on ensuring expense creation and settlement flows produce consistent audit records for both admin and member activity.

## Why this matters
Per the contribution guidelines, every group action and state change must produce an audit log. Currently, some expense creation and settlement endpoints do not route through a centralized audit trail, leaving gaps in accountability and making incident review, compliance reporting, and dispute resolution harder.

Without a unified logging layer, these actions are easy to miss or implement inconsistently across routes. That creates operational risk, weak traceability, and incomplete historical records for sensitive financial workflows.

## Requirements
- Add a central audit logging helper or middleware that records actor, group, action, and payload metadata consistently.
- Ensure admin and member actions are audited for expense creation and settlement-related flows.
- Store audit entries in the database in a secure, structured, and queryable format.
- Cover relevant state transitions so each action has a complete audit trail.
- Avoid duplicating audit logic across handlers by centralizing the behavior in one reusable path.

## Expected behavior
- Each relevant group action creates an audit record with the actor, target resource, and action details.
- Settlement and expense creation endpoints emit a record when the action is processed.
- Audit entries include enough metadata to reconstruct what changed and who initiated it.
- Logging behavior is centralized so future group actions can be covered without ad hoc implementations.

## Impact
This improves accountability and traceability across group financial activity, ensures the project meets its audit requirements, and reduces the risk of missing or inconsistent records during investigations, support requests, and compliance reviews.

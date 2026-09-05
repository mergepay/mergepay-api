# Issue #333 — Lifecycle management for DB connections and Fastify server instances

## Summary
Proper lifecycle management for database connections and Fastify server instances ensures zero dropped requests during deployments and container restarts. This issue adds a dedicated health check endpoint verifying database connectivity and implements graceful shutdown hooks for Prisma and Fastify.

## Why this matters
When the app is stopped or restarted, background processes and in-flight requests can be interrupted if database clients and the HTTP server are not closed cleanly. The result is dropped traffic, noisy container restarts, and degraded availability during deployments.

## Requirements
- Add a health endpoint that verifies database connectivity using the Prisma client.
- Return a proper HTTP status code based on database health.
- Close the Fastify server gracefully on process termination.
- Disconnect Prisma cleanly on SIGTERM/SIGINT.
- Ensure shutdown is deterministic and does not leave connection handles open during restart or deployment.

## Expected behavior
- A health endpoint should succeed when the database is reachable.
- The health endpoint should fail or return a non-200 status when the database is unavailable.
- On SIGINT or SIGTERM, the server should stop accepting new connections and close resources in a controlled manner.
- Prisma should be disconnected cleanly as part of shutdown.

## Impact
This improves reliability during container restarts, orchestration rollouts, and graceful termination events while reducing the risk of dropped requests and stale database connections.

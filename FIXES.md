# Accuracy and reliability change record

Status refers to implemented code and synthetic tests, not live finance reconciliation.

| Review issues | Resolution |
|---|---|
| 1?5: currencies, base amounts, precision, invalid/missing numbers | Strict decimal parsing from HTTP ingestion; currency-specific display; explicit base/transaction modes; missing values withhold totals |
| 6: generic financial summation | Explicit validated source metrics; unsupported accounting interpretations rejected |
| 7: date/filter behavior | Typed inclusive dates/statuses validated locally; unknown arguments rejected by strict schemas |
| 8?9: malformed responses/first array | Module-specific response arrays required |
| 10?12: pagination, duplicates, cap | Resumable encrypted snapshots; null metadata requires another page; duplicate detection; bounded storage blocks completion; every page rechecked |
| 13?15: organization scope | Complete explicit scope required; missing entities rejected; preference no longer implicitly controls reads |
| 16: raw list completeness | Raw returned count and pagination marker; no financial completeness claim |
| 17?19: collections/revenue/history | Gross collection definition; source-field reports; no invented recognized revenue or historical balances |
| 20: aging | Explicit current as_of; missing balance/due date invalidates grouping; no invoice-date fallback |
| 21?22: groups | Stable IDs; all groups stored and paginated |
| 23?24: consolidation/instructions | No intercompany elimination claims; instructions align with actual tools and limits |
| 25?27: verification/evidence/tests | Separate retrieval/field/reconciliation statuses; exact receipt comparison; encrypted evidence, source rows and provenance; regression tests |
| 28?30: API/network/output | HTTP + API validation, read timeouts/retries, partial failures, valid JSON fragments for large responses |
| 31: deployment/docs | Updated OAuth/config/docs/tool counts, locked dependencies, build ID, CI |
| Security | Exact Zoho origins, no redirects, encrypted refresh/client secrets, hashed bearer tokens, verified PostgreSQL TLS, transactional token rotation, client-scoped grant revocation |
| Writes | Validated common fields, explicit org, preview/confirmation, stale-record comparison, persistent idempotency keys and atomic claim, unknown-outcome protection |
| Operations | Read-only default/scopes, token refresh coordination/versioned cache, bounded output/requests, sanitized errors, cleanup/shutdown |

## Acceptance items requiring external evidence

- Reconcile Via Oman's August 2026 receipts with finance's real export and exact collection definition. Both screenshots are unverified.
- Verify regional/custom-module API shapes, scopes and writable fields with the user's Zoho tenant. Unexpected shapes or missing scopes fail closed.
- Agree whether additional reports should represent net bank receipts, allocations, recognized revenue, historical balances or consolidated accounts. Those are distinct implementations, not aliases for gross collections.
- Verify the new build in the deployed environment, HTTPS proxy, actual OAuth consent/reconnection and managed-database CA configuration.

## Practical limits

Zoho does not participate in a local database transaction. Two matching retrieval passes improve consistency but cannot guarantee an atomic source snapshot. The final read-before-write also cannot eliminate the remote edit race without upstream conditional-write support. No live accounting data was used as a regression fixture.

A fresh database encryption key and pre-upgrade backup are required for first deployment. Keep the key stable. Review README.md before migrating existing credentials.

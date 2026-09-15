# Financial assurance and operation

Version 3.2 implements eight improvements. Software validation and finance acceptance remain separate: no real approved exports or five-entity registry were available during implementation. Neither passing tests nor two matching API reads guarantees 100% accounting accuracy.

| Improvement | Implementation | Production prerequisite |
|---|---|---|
| Reference cases | Strict, encrypted reference imports; captured API fixture replay | Actual exports and independently approved expected records for each entity |
| Automatic reconciliation | Compare every record, amount and currency under the exact saved scope | Install matching references; current balances require a reference within five minutes of retrieval |
| Definitions | Versioned gross receipts, current customer receivables, historical closing balances and explicit source metrics | Finance review if a different business definition is intended |
| Five-entity coverage | Expected IDs, access checks, omitted/missing entity diagnostics | Register the actual IDs; never infer five entities from whatever access remains |
| Question checks | Deterministic supported-question planner tested through authenticated MCP HTTP | Actual ChatGPT client behavior and real finance examples need separate acceptance |
| Historical/timezone support | Explicit imported closing balances and per-entity calendar checks | Approved historical export with cutoff and timezone; current balances cannot substitute |
| Audit access | Encrypted snapshots retained 30 days; expiring JSON/CSV downloads | Retention can be configured from 1–365 days |
| Operations | Durable jobs, rate pacing/backoff, status/monitor command, scoped deployment, backups and isolated restore drills | Deploy and install timers; configure an operator's existing alert delivery separately |

## Existing ChatGPT connection

Keep the public URL, OAuth registration, user database, encryption key and access mode unchanged. The new tools require no additional Zoho scopes. After a successful server upgrade, people continue using their existing MCP connection. The server resumes unfinished reports in the background; ChatGPT reads their report ID for the completed answer. There is no unsolicited message to the user when a background job completes.

`figures_are_complete` means the configured retrieval and value checks passed. `reconciliation_status` and `reference_check` explain whether actual reference records were compared. Matching reads are not an atomic Zoho snapshot. A source that keeps changing remains unverified.

## Entity configuration

Use `ZohoBooks_list_organizations` to discover real IDs. Set `EXPECTED_ORGANIZATION_IDS` to the agreed five IDs in the server environment, preserving the existing credentials. Until registered, explicit entity reports work but `all_organizations` fails with an explanation. A missing accessible entity prevents an all-entity result instead of silently shrinking it. Totals and rankings stay separate by organization and currency.

## Reference import (operator only)

The application does not expose a tool for an assistant to approve its own answer. A trusted operator maps an actual exported report into the schema in `finance-reference.js`, including its exact report specification, organizations/timezones, record IDs, currencies and decimal amounts. Record IDs are payment IDs for receipts and contact IDs for customer balances. The original export's SHA-256, export timestamp, approver and approval timestamp are required. This is recorded provenance, not independent proof of the approver's identity or automatic validation of the operator's row mapping.

Run inside the deployed application environment, with both input files accessible to the process:

```sh
node scripts/finance-admin.mjs import USER_ID REFERENCE.json ORIGINAL_EXPORT.csv
```

The importer checks the original file's hash and current account access. Reference payloads are encrypted, owner-scoped and expire after a year. Synthetic fixtures cannot be installed through this command. For historical data use `historical_receivables_v1`, `kind: historical_receivables`, `module: contacts`, `metric: closing_balance`, `group_by: customer`, and the explicit `as_of` date. The historical tool identifies imported provenance and does not claim independent reconciliation.

For regression replay, provide a private `FINANCE_FIXTURE_DIR` with JSON files containing `reference` and `source_records` (each captured API row wrapped as `{organization_id, record}`). Run `npm run test:finance`; set `REQUIRE_FINANCE_FIXTURES=true` to fail when no directory is supplied. Without actual fixtures, CI prints `finance_validation_pending`. Do not commit customer records or approval exports to Git. The replay checks captured data, not today's live Zoho state.

## Audit downloads

`export_report` returns a five-minute bearer link bound to the account, report, format and section. Anyone holding it can download until expiry, subject to current account/domain and Zoho organization access. The endpoint disables caching and application logs omit the query string. Protect proxy logs too. JSON includes all audit sections; CSV exports one section with completeness labels, escaped formulas and opaque IDs preserved as text. Oversized exports return an error and can be fetched through paginated `get_report`; nothing is silently truncated.

## Background work and monitoring

Jobs are stored in PostgreSQL. Atomic leases prevent simultaneous continuations from claiming the same job, and expired leases can be recovered after a restart. Revision checks prevent stale saves. Each batch defaults to two source requests. Transient failures have bounded retries; long upstream Retry-After delays are preserved. Source-field mismatches still fail verification. Request pacing is per organization/API origin within this process; it is not a distributed quota governor for multiple app replicas.

`npm run monitor` checks database access, each linked account's Zoho access, expected-entity coverage and job outcomes. It prints structured status without financial records or tokens and exits nonzero when attention is required. `connector_status` exposes only the caller's status. `/health` remains the lightweight database health endpoint. Systemd records monitoring failures in the journal; external notification delivery is not configured or sent by this release.

## App-only deployment and recovery

After GitHub verification succeeds for the exact commit, run on Contabo:

```sh
python3 /path/to/reviewed/ops/deploy.py FULL_40_CHARACTER_COMMIT_SHA
python3 /opt/via/zoho-mcp/ops/install-timers.py
python3 /opt/via/zoho-mcp/ops/backup.py --verify-restore
```

The deployer takes an application-specific lock, builds the pinned release before replacement, preserves existing credentials/settings, backs up source and PostgreSQL, and replaces only `zoho-mcp-app` using `--no-deps`. It verifies the build/version/tool count, linked accounts and unrelated container identities/restart counts. Failed app health triggers app/source rollback; new database tables are additive. It never restarts Caddy, another app or the production database. Check `deployment-result.json` for any unrelated container changes, which can also arise from external activity.

The installer enables only the three `zoho-mcp-*` timers. Daily backups and weekly restore drills write protected directories under `/opt/via/zoho-mcp-backups`. Restore drills use a temporary container with no network or published ports and verify that restored credentials decrypt with the retained application key. A disk-space guard stops backups before consuming the last reserve. Backups are not automatically deleted; an operator must manage retention and separately protected/off-host copies. Keeping the key beside a local dump supports recovery but does not protect against loss of the server itself.

Live deployment, timer execution, restore-drill results, actual entity registration and finance acceptance must each be checked and reported separately. Prepared scripts are not evidence that those production actions ran.

# Zoho Books MCP ? version 3

A multi-user OAuth server for Zoho Books. Every caller uses their own linked Zoho account. Accounting records remain in Zoho; temporary encrypted report snapshots preserve the evidence used to calculate an answer.

## Accuracy contract

- Every call names its organization(s); an account preference never silently changes report scope.
- Monetary values are decimal strings. Exact sums are retained; display rounding follows currency precision, including OMR's three decimals.
- Transaction currency and organization base currency are separate. Base reports use recorded `bcy_*` amounts or an explicitly matching transaction currency. Missing amounts/currencies invalidate the result; no exchange rates are guessed.
- Date/status filtering is performed locally over all retrieved records, so unsupported upstream filters cannot silently widen a monthly result.
- Every source page is read twice and compared. Duplicate IDs, malformed responses, inaccessible organizations, changed pages and missing fields prevent a final total. This detects many source changes but cannot create a transactional snapshot of Zoho.
- Reports run in bounded batches of API requests. Continue the same report ID until retrieval and verification finish. Totals are null while incomplete. Never add successive summaries.
- Receipt evidence, all groups, exclusions, original source records, and validation errors can be retrieved from the encrypted snapshot for 24 hours.
- `figures_are_complete` means retrieval and configured field validation succeeded. It does not mean finance reconciled the report.

## Financial definitions

`collections_report` calculates **gross recorded customer-payment receipts by payment date**, with inclusive start/end dates. It does not subtract refunds, bank charges or withholding, and it does not substitute invoice allocations or net bank deposits. Collection reports default to recorded base currency.

The general `list` summary supports explicit source metrics: count; payment/expense amount; invoice/bill total or current balance; and selected document totals. It is not a recognized-revenue report, a consolidated financial statement, or a reconstructed historical balance.

For example, date-filtered invoice balances are today's source balances on invoices dated in that range. They are not what was outstanding at that historic month-end. Historical `as_of` balances are rejected. Aging requires current balances, explicit due dates and an explicit as_of equal to today's UTC date; missing information is an error.

Net collections, recognized revenue, historic balances and intercompany eliminations require finance-approved rules or an appropriate Zoho source report. Unsupported interpretations are rejected/described explicitly rather than guessed.

## Tools

Nine tools in read-only mode; thirteen when accounting writes are enabled:

| Tool | Purpose |
|---|---|
| ZohoBooks_collections_report | Gross payment-date receipts with explicit dates/scope |
| ZohoBooks_list | One raw page or an explicit source-field summary |
| ZohoBooks_continue_report | Resume retrieval and the verification pass |
| ZohoBooks_get_report | Read summary/evidence/groups/errors/source records in pages or fragments |
| ZohoBooks_reconcile_report | Compare every monetary record with a supplied finance reference |
| ZohoBooks_get | Read one record in an explicit organization |
| ZohoBooks_describe_module | Static field hints and available operations |
| ZohoBooks_list_organizations | List accessible entities and currencies |
| ZohoBooks_set_default_organization | Save a convenience preference, not implicit scope |
| ZohoBooks_create/update/delete | Prepare a write preview only |
| ZohoBooks_confirm_write | Execute a confirmed preview once |

The module registry covers the existing 24 modules. Static field hints are not a complete regional schema. Zoho still validates custom and region-specific rules. Unsupported response shapes stop with an error instead of being treated as empty.

Example collections arguments:
```json
{
  "organization_id": "ID_FROM_LIST_ORGANIZATIONS",
  "date_start": "2026-08-01",
  "date_end": "2026-08-31",
  "currency_basis": "base"
}
```

Use `get_report` with `section: "evidence"` for individual receipts; follow `next_page`. If a single record/page exceeds the output limit, follow `next_offset` and concatenate the JSON text fragments before parsing. Every fragment is itself returned inside valid JSON.

`reconcile_report` requires an actual reference label and rows containing organization_id, record_id, currency, and amount (a decimal string). It detects missing/extra receipts as well as amount/currency differences. Its status is `matches_supplied_reference` or `differs_from_supplied_reference`; it does not authenticate the reference or claim independent finance approval.

## Setup

1. Install Node 22+ and PostgreSQL.
2. Create a Zoho **Server-based Application**, with the redirect URI exactly `PUBLIC_URL/zoho/callback`.
3. Copy `.env.example` to `.env` and fill in the application credentials, public HTTPS origin, database URL, domain allowlist and encryption key.
4. Generate a persistent key once:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
5. Run `npm ci`, then `node --env-file=.env server.js`.
6. Configure a compatible MCP client for the public `/mcp` URL using OAuth with dynamic client registration. Each user links their own Zoho account.
7. Check `/health` for version, build ID, read-only status and loaded-tool count. Health checks verify PostgreSQL, not live Zoho permissions.

The previous API-key/Self-Client instructions do not apply. `MCP_API_KEY`, `ZOHO_REFRESH_TOKEN` and `ZOHO_ORGANIZATION_ID` are not used.

Read-only is the default. It requests explicit Zoho read scopes. Existing connections authorized with full access must be revoked/reconnected if their upstream permissions should also be narrowed. Set `ZOHO_READ_ONLY=false` to expose the write workflow and reconnect for write scopes. A missing scope produces an error; it never produces a valid zero report.

Zoho documents custom-module record access under custommodules.ALL, so those records are unavailable in strict read-only mode. Custom-module definitions remain readable through settings.READ. No broader scope is silently requested.

## Safe writes

Each create/update/delete request supplies explicit organization and a UUID idempotency_key. It produces a ten-minute preview containing the target, current record and proposed changes. Show this to the human before calling confirm_write with user_confirmed:true.

The server atomically claims an operation once, rechecks access and compares the current record with the preview. If Zoho cannot provide the current record, update/delete cannot proceed safely. A network interruption after dispatch produces an unknown outcome; inspect Zoho and the same operation ID before attempting any fresh operation. Confirming the same operation again never dispatches it again.

This is not a database transaction with Zoho: a remote edit can still happen between the final read and write. The server cannot independently prove that a human approved an assistant's boolean; the client must enforce the actual confirmation UI. Preview records and write outcomes are encrypted in PostgreSQL. Completed/unknown operation keys are retained to preserve duplicate protection; do not delete them casually.

## Security and upgrades

Required `TOKEN_ENCRYPTION_KEY`: 64 hexadecimal characters, shared by all replicas. Back it up securely and keep it stable. On startup, migration transactionally encrypts existing plaintext Zoho refresh tokens and client secrets and hashes existing MCP tokens. Existing nonexpiring refresh tokens get a 30-day expiry. Refresh rotation and issuing replacements are transactional. Revocation removes the user's token grant for that MCP client.

Back up the database before the first v3 deployment. A migration locks credential tables briefly. After migration the old version cannot read encrypted credentials; rollback requires the pre-upgrade backup. Losing the encryption key makes stored credentials and reports unreadable. Key rotation requires an explicit decrypt/re-encrypt migration; replacing the environment variable alone is not rotation.

Only approved Zoho HTTPS origins are accepted; redirects are rejected. Managed PostgreSQL certificate verification is enabled. Supply `DATABASE_CA_PEM` if your provider uses a private CA. `DATABASE_SSL=false` is only appropriate for the private/local PostgreSQL connection. Use URL-encoded database passwords or the generated hexadecimal password in the Compose template.

Reports expire after 24 hours and hourly cleanup removes expired snapshots and OAuth artifacts. Application logs omit tokens and report contents. Restrict proxy log access; OAuth callback query strings should not be retained.

## Limits and operation

- HTTP reads: 20-second attempt timeout, up to three attempts for transient failures. Writes are never automatically retried.
- A report call performs up to ten page requests. Calls continue from encrypted state and use optimistic concurrency to reject conflicting updates.
- MAX_REPORT_RECORDS defaults to 100,000 per snapshot. Hitting it blocks a final total. Because date filtering is local, a shorter requested date range does not reduce upstream scanning. For organizations beyond this limit use a native export or raise the bound after capacity review.
- MAX_API_BYTES defaults to 8 MB per upstream response. MAX_RESPONSE_CHARS defaults to 60,000; oversized output is stored and read through get_report.
- Two concurrent MCP requests per user per process. For multiple replicas, put shared rate limits at the proxy. Stable encryption key and PostgreSQL are shared.
- Set BUILD_ID to the deployed commit so a finance incident can be tied to its exact implementation.

## Verification

`npm test` runs unit tests; the PostgreSQL integration test runs when TEST_DATABASE_URL names a disposable database. Never point that variable at a real application database. Integration tests use synthetic users, OAuth credentials and Zoho responses; they do not access live Zoho.

`npm audit` checks dependencies. CI runs unit/integration tests with PostgreSQL 16. See FIXES.md for issue coverage and acceptance work still requiring finance evidence.

For the August incident, obtain the actual finance export, original tool inputs/output and deployed build. Neither screenshot is an approved expected result.

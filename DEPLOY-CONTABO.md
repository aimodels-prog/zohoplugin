# Deploy v3 on the existing Contabo proxy stack

This Compose file creates the app and a private PostgreSQL instance. It uses the existing external `via_proxy` network and existing Caddy service; it does not create another Caddy container or expose PostgreSQL publicly.

1. Back up the existing Zoho MCP database before the v3 credential migration. Preserve the backup securely. Do not touch unrelated databases.
2. Copy the project to its application directory and copy `.env.production.example` to `.env`. Fill in PUBLIC_URL, POSTGRES_PASSWORD, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ALLOWED_EMAIL_DOMAINS, a persistent TOKEN_ENCRYPTION_KEY, and BUILD_ID (the deployed commit).
3. The encryption key is 64 random hex characters. Keep it stable and backed up separately. The database password may also be generated as hex to avoid URL encoding issues.
4. Confirm the existing Caddy network is named `via_proxy`. Back up the existing proxy configuration, add the block in Caddyfile.snippet with your hostname, validate and reload the existing proxy. The standalone Caddyfile is a template only and is not used by this Compose file.
5. Point the chosen hostname at this server and register `PUBLIC_URL/zoho/callback` exactly in the Zoho Server-based Application.
6. Run `docker compose config --quiet`, then `docker compose up -d --build`. Inspect app logs for startup and verify HTTPS `/health` reports version 3.0.0 and the expected build ID.
7. Refresh the MCP client's tool schemas. V3 requires explicit organization IDs and uses new report and write-preview tools. Reconnect users if scopes changed from full access to read-only.
8. Run a small collections report, retrieve receipt evidence, and compare it to finance's actual source report before accepting production figures.

Private Postgres uses DATABASE_SSL=false within the Compose network. Managed database connections must verify certificates instead.

Startup encrypts legacy credentials. Do not roll the old app back against the upgraded database: restore the pre-upgrade backup if rollback is needed. Do not regenerate TOKEN_ENCRYPTION_KEY on deployment.

Use the existing Caddy service's logs, not `docker compose logs caddy` in this application directory. Restrict access to logs and strip OAuth query strings. Back up PostgreSQL and the encryption key; snapshots expire, but credentials and operation audit records are persistent.

No deployment is performed by editing these files.

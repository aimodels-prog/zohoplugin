# Deploying to Contabo

Moves the server off Railway onto your own VPS. Three containers: the app, Postgres, and
Caddy (which handles HTTPS certificates automatically).

Budget ~30 minutes. Do it **before** onboarding colleagues — right now only two accounts are
linked, so the whole migration costs two people clicking Connect once.

---

## Step 1 — Point a subdomain at the server

In your DNS provider for `via-int.com`, add:

| Type | Name | Value |
|---|---|---|
| A | `books-mcp` | your Contabo IPv4 address |

Wait for it to resolve before continuing — Caddy cannot issue a certificate until it does:

```bash
nslookup books-mcp.via-int.com
```

It must return your Contabo IP. DNS can take a few minutes.

> Using your own domain rather than a provider hostname is the point of this move. Every
> future host change becomes a DNS edit instead of re-registering the Zoho app and making
> everyone rebuild their connector.

---

## Step 2 — Prepare the server

SSH in:

```bash
ssh root@YOUR_CONTABO_IP
```

Install Docker if it isn't there (`docker --version` to check):

```bash
curl -fsSL https://get.docker.com | sh
```

Open the web ports. If `ufw status` says inactive, skip this:

```bash
ufw allow 80/tcp && ufw allow 443/tcp && ufw reload
```

---

## Step 3 — Upload the project

From **your Windows machine**, in a Git Bash terminal, from inside the `zoho-books-mcp`
folder. This copies the source without `node_modules` or any local secrets:

```bash
tar czf - --exclude=node_modules --exclude=.git --exclude=.env --exclude=.railway . | ssh root@YOUR_CONTABO_IP "mkdir -p /opt/zoho-books-mcp && tar xzf - -C /opt/zoho-books-mcp"
```

---

## Step 4 — Configure

Back on the server:

```bash
cd /opt/zoho-books-mcp && cp .env.production.example .env
```

Generate a database password:

```bash
openssl rand -hex 24
```

Then edit `.env` (`nano .env`) and fill in:

- `DOMAIN` and `PUBLIC_URL` — your subdomain
- `POSTGRES_PASSWORD` — the string you just generated
- `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` — from the Zoho API Console
- `ALLOWED_EMAIL_DOMAINS` — `via-int.com`

Lock the file down, since it holds your Zoho secret:

```bash
chmod 600 .env
```

---

## Step 5 — Start it

```bash
cd /opt/zoho-books-mcp && docker compose up -d --build
```

Watch it come up:

```bash
docker compose logs -f app
```

You want to see `[db] schema ready` followed by the listening banner. `Ctrl+C` to stop
watching (containers keep running).

Certificate issuance takes a few seconds on first boot:

```bash
docker compose logs caddy | grep -i certificate
```

---

## Step 6 — Verify

```bash
curl https://books-mcp.via-int.com/health
```

Expect `{"status":"ok","tools":61,"readOnly":false,"linkedUsers":0}`.

A valid certificate with no `-k` flag means HTTPS is working, which is what ChatGPT requires.

---

## Step 7 — Update Zoho

At **https://api-console.zoho.com** → your "Books MCP" client → **Update Redirect URIs**.

Replace the Railway URL with:

```
https://books-mcp.via-int.com/zoho/callback
```

Zoho matches this **exactly** — no trailing slash, `https` not `http`. This is the single
most common cause of a failed link.

---

## Step 8 — Reconnect ChatGPT

The old connector points at Railway and will stop working. In **each** ChatGPT account:

1. Settings → Plugins → Zoho Books → **⋯** → Delete
2. Recreate it with the new server URL:
   ```
   https://books-mcp.via-int.com/mcp
   ```
   Authentication **OAuth**, registration method **Dynamic Client Registration (DCR)**
3. **Connect** → sign in with that person's Zoho account

Confirm both landed:

```bash
curl https://books-mcp.via-int.com/health
docker compose logs app | grep "oauth] linked"
```

---

## Step 9 — Decommission Railway

Only after the Contabo server is confirmed working. In the Railway dashboard, delete the
`zoho-books-mcp` project (app + Postgres). That stops the trial burning down and removes a
second copy of your Zoho credentials from the internet.

---

## Day-to-day

**Deploy a change** — re-run the Step 3 upload, then:

```bash
cd /opt/zoho-books-mcp && docker compose up -d --build
```

Because sessions live in Postgres, restarts and rebuilds no longer break anyone's
connection. Nobody has to reconnect.

**Logs**

```bash
docker compose logs -f app
```

**Back up the database.** It holds every user's Zoho refresh token — treat the dump as a
secret, and store it somewhere access-controlled:

```bash
docker compose exec -T postgres pg_dump -U zoho zoho_books | gzip > backup-$(date +%F).sql.gz
```

Worth putting in a weekly cron job. Losing it means everyone re-links; leaking it means
someone else can reach your books.

**Restore**

```bash
gunzip -c backup-YYYY-MM-DD.sql.gz | docker compose exec -T postgres psql -U zoho zoho_books
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Caddy can't get a certificate | DNS not pointing at this server yet, or port 80 blocked. Check `nslookup` and `ufw status`. |
| `ECONNREFUSED` to postgres | Started before the DB was ready. `docker compose restart app`. |
| DB connection hangs or TLS error | `DATABASE_SSL=false` must be set — it is in `docker-compose.yml`; don't override it in `.env`. |
| `invalid_client` from Zoho | Client ID/secret wrong, or the app isn't a Server-based Application. |
| Zoho redirect mismatch | Registered URI doesn't exactly match `PUBLIC_URL` + `/zoho/callback`. |
| ChatGPT can't connect | URL needs `/mcp` on the end. |
| Connector connects but no tools | Click **Refresh** on the connector, then start a **new chat** — ChatGPT fixes the tool list at conversation start. |

# Zoho Books MCP Server for ChatGPT

Exposes 60 Zoho Books tools to ChatGPT as a custom connector.

Read 30 · Create 12 · Update 10 · Delete 8

---

## How the pieces fit together

```
ChatGPT  ──HTTPS──>  this server (hosted)  ──HTTPS──>  Zoho Books API
         Bearer key                        OAuth token
```

ChatGPT can only talk to a server that is **on the public internet over HTTPS**. It cannot
reach a program running on your laptop. So the work is: get credentials from Zoho → put this
server on a host → paste the host's URL into ChatGPT.

Budget about 45 minutes the first time.

---

## Step 1 — Get your Zoho credentials

### 1a. Create a Self Client

1. Go to **https://api-console.zoho.com** — but use the address that matches your region:
   `.eu`, `.in`, `.com.au`, `.jp`, `.ca`, `.sa`, `.uk`.
   *Not sure which?* Log into Zoho Books and look at the address bar. `books.zoho.eu` means
   you use `api-console.zoho.eu` and region `eu`.
2. Click **ADD CLIENT**.
3. Choose **Self Client** (the last option — it's for server-side scripts with no website).
4. Click **CREATE**, then **OK**.
5. You now see **Client ID** and **Client Secret**. Copy both somewhere safe.

### 1b. Generate a grant code

1. Still in the API Console, open the **Generate Code** tab.
2. **Scope**: `ZohoBooks.fullaccess.all`
3. **Time Duration**: `10 minutes`
4. **Scope Description**: `MCP` (anything works)
5. Click **CREATE**, pick your organization, click **CREATE** again.
6. Copy the code that appears. **It expires in 10 minutes** — go straight to the next step.

> Prefer narrower access? Use this instead of `fullaccess.all`:
> `ZohoBooks.contacts.ALL,ZohoBooks.invoices.ALL,ZohoBooks.estimates.ALL,ZohoBooks.salesorders.ALL,ZohoBooks.purchaseorders.ALL,ZohoBooks.expenses.ALL,ZohoBooks.customerpayments.ALL,ZohoBooks.settings.ALL,ZohoBooks.banking.READ,ZohoBooks.accountants.READ,ZohoBooks.users.READ`
> Start with `fullaccess.all` to confirm everything works, then tighten it later — a missing
> scope produces a confusing error and is the most common cause of a stuck setup.

### 1c. Turn the code into a permanent refresh token

Open PowerShell in this folder and run:

```bash
node get-refresh-token.js YOUR_CLIENT_ID YOUR_CLIENT_SECRET YOUR_GRANT_CODE com
```

Replace `com` with your region if different. It prints the four values you need.

---

## Step 2 — Test it on your own machine

```bash
npm install
```

Copy `.env.example` to `.env` and fill in the values from Step 1c:

```bash
Copy-Item .env.example .env
```

Add a random `MCP_API_KEY` — generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then verify your credentials actually work:

```bash
.\run-local.ps1 -Check
```

You should see your organizations listed. Copy the `organization_id` you want into
`ZOHO_ORGANIZATION_ID` in `.env`. Then start the server:

```bash
.\run-local.ps1
```

Visit http://localhost:8080/health — you should see `{"status":"ok","tools":60,...}`.
Press `Ctrl+C` to stop.

---

## Step 3 — Put it on the internet

Pick one. **Railway is the least fiddly** because it uploads this folder directly with no
GitHub account needed.

### Option A — Railway (recommended)

```bash
npm install -g @railway/cli
```

```bash
railway login
```

```bash
railway init
```

```bash
railway up
```

Then in the Railway dashboard for your new project:

1. **Variables** tab → add each line from your `.env` file
   (`ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_REGION`,
   `ZOHO_ORGANIZATION_ID`, `MCP_API_KEY`).
2. **Settings** → **Networking** → **Generate Domain**.
3. You get a URL like `https://zoho-books-mcp-production.up.railway.app`.

Check it works by opening that URL in a browser — you should see the "server is running" text.

### Option B — Render

Needs a GitHub account. Push this folder to a **private** GitHub repo, then at
render.com: **New** → **Web Service** → connect the repo. `render.yaml` configures it
automatically; you just fill in the Zoho values under **Environment**.

### Option C — Quick temporary test with ngrok

Only for trying it out — the URL dies when you close it and your PC must stay on.

```bash
npm install -g ngrok
```

Start the server locally (`.\run-local.ps1`), then in a second terminal:

```bash
ngrok http 8080
```

Use the `https://....ngrok-free.app` address it prints.

---

## Step 4 — Add it to ChatGPT

Requires a **Plus, Pro, Business, Enterprise or Edu** plan, on **chatgpt.com in a browser**
(not the mobile app).

1. **Settings** → **Apps & Connectors** → **Advanced settings** → turn on **Developer mode**.
2. Go back to **Apps & Connectors** → **Create** / **Add custom connector**.
3. Fill in:
   - **Name**: `Zoho Books`
   - **MCP Server URL**: your URL from Step 3 **with `/mcp` on the end** —
     e.g. `https://zoho-books-mcp-production.up.railway.app/mcp`
   - **Authentication**: choose **API Key** (sometimes labelled *Access token / API key*)
   - **API Key**: paste your `MCP_API_KEY`
4. Tick the box confirming you trust the connector, then **Create**.

ChatGPT will connect and show the 60 tools. If it shows an error, see Troubleshooting below.

### Using it

In a new chat, open the **+** menu → **Developer mode** and enable the Zoho Books connector.
Then just ask normally:

- "List my 10 most recent unpaid invoices"
- "Show me contact ABC Trading and their outstanding balance"
- "Create a draft invoice for customer X for 3 days of consulting at 450 OMR/day"
- "What did we spend on subcontractors last quarter?"

ChatGPT will ask you to confirm before any tool runs the first time.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| ChatGPT: "Could not connect" | URL is missing `/mcp` at the end, or the host is asleep — open the URL in a browser first to wake it. |
| ChatGPT: 401 error | `MCP_API_KEY` in ChatGPT doesn't match the one set on the host. Re-copy it, no spaces. |
| `invalid_client` | Wrong Client ID/Secret, **or wrong region** — a `.com` console client won't work against `.eu`. |
| `invalid_code` | The grant code expired (10 min). Generate a new one and run `get-refresh-token.js` immediately. |
| Tool returns "You are not authorized" | Missing scope. Regenerate the grant code with `ZohoBooks.fullaccess.all`. |
| Tool returns HTTP 429 | Zoho rate limit. Wait a minute; use `per_page` to fetch less. |
| Everything works, then breaks weeks later | Zoho keeps only the 20 newest refresh tokens per account. If you generated many, older ones get revoked. Generate a fresh one. |

Server logs: `railway logs` on Railway, or the **Logs** tab on Render.

---

## Security notes

- **Your `MCP_API_KEY` is the only thing standing between the internet and your accounting
  data.** The server refuses to start without one. Use a long random value; don't reuse it.
- **This connector can delete invoices, contacts and payments.** Set `ZOHO_READ_ONLY=true`
  to drop all 30 write tools and expose only the read tools. Recommended until you trust it.
- The refresh token never expires. If it leaks, revoke it in the Zoho API Console
  (**Self Client** → **Revoke**) and generate a new one.
- Keep `.env` out of version control — `.gitignore` already covers it.
- Treat data ChatGPT reads back from Zoho as information, not instructions. If a customer
  note or invoice comment contains text telling the assistant to do something, that is not
  a command from you.

---

## Reference

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ZOHO_CLIENT_ID` | yes | From the Zoho API Console Self Client |
| `ZOHO_CLIENT_SECRET` | yes | Same place |
| `ZOHO_REFRESH_TOKEN` | yes | From `get-refresh-token.js` |
| `MCP_API_KEY` | yes | Shared secret ChatGPT sends as `Authorization: Bearer …` |
| `ZOHO_REGION` | no | `com` (default), `eu`, `in`, `au`, `jp`, `ca`, `sa`, `uk` |
| `ZOHO_ORGANIZATION_ID` | no | Default org, so tools don't need it passed each call |
| `ZOHO_READ_ONLY` | no | `true` hides all create/update/delete tools |
| `MAX_RESPONSE_CHARS` | no | Truncate large responses (default 60000) |
| `PORT` | no | Set automatically by hosts |

### Files

| File | Purpose |
|---|---|
| `server.js` | HTTP + MCP transport + auth |
| `tools.js` | The 60 tool definitions |
| `zoho.js` | OAuth token refresh + Zoho API calls |
| `check.js` | `npm run check` — credential test, lists organizations |
| `get-refresh-token.js` | One-time grant code → refresh token |
| `run-local.ps1` | Loads `.env` and starts the server on Windows |

### Tools

**Read (30)** — `get_contact` `get_custom_module` `get_custom_module_record`
`get_customer_payment` `get_estimate` `get_expense` `get_invoice` `get_item`
`get_organization` `get_purchase_order` `get_sales_order` `get_tax` `get_user`
`list_bank_accounts` `list_chart_of_accounts` `list_contacts` `list_currencies`
`list_custom_fields` `list_custom_module_records` `list_custom_modules`
`list_customer_payments` `list_estimates` `list_expenses` `list_invoices` `list_items`
`list_organizations` `list_purchase_orders` `list_sales_orders` `list_taxes` `list_users`

**Create (12)** — `create_contact` `create_custom_field` `create_custom_module`
`create_custom_module_record` `create_customer_payment` `create_estimate` `create_expense`
`create_invoice` `create_item` `create_purchase_order` `create_sales_order` `create_tax`

**Update (10)** — `update_contact` `update_custom_field` `update_custom_module`
`update_customer_payment` `update_estimate` `update_expense` `update_invoice` `update_item`
`update_purchase_order` `update_sales_order`

**Delete (8)** — `delete_contact` `delete_customer_payment` `delete_estimate`
`delete_expense` `delete_invoice` `delete_item` `delete_purchase_order` `delete_sales_order`

All names are prefixed `ZohoBooks_`.

Every `list_` tool accepts `page`, `per_page`, `sort_column`, `sort_order`, `search_text`,
`filter_by`, and a free-form `params` object for any other Zoho query parameter. Every tool
accepts an optional `organization_id` to override the default.

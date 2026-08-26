// Multi-tenant remote MCP server for Zoho Books, speaking Streamable HTTP at POST /mcp.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import tools, { READ_ONLY } from "./tools.js";
import * as db from "./db.js";
import { ZohoOAuthProvider, zohoCallbackHandler } from "./oauth.js";

const PORT = process.env.PORT || 8080;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Startup validation — fail loudly rather than half-working in production.
// ---------------------------------------------------------------------------

const missing = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "PUBLIC_URL", "DATABASE_URL"].filter(
  (k) => !process.env[k]
);

if (missing.length) {
  console.error(`\n[FATAL] Missing required environment variables: ${missing.join(", ")}`);
  console.error(`        See .env.example and the README.\n`);
  process.exit(1);
}

let issuerUrl, resourceServerUrl;
try {
  issuerUrl = new URL(PUBLIC_URL);
  resourceServerUrl = new URL(PUBLIC_URL + "/mcp");
} catch {
  console.error(`\n[FATAL] PUBLIC_URL "${PUBLIC_URL}" is not a valid URL.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// MCP server factory (stateless: one instance per request)
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new McpServer(
    { name: "zoho-books", version: "2.0.0" },
    {
      instructions:
        "Tools for reading and writing the signed-in user's own Zoho Books accounting data. " +
        "IDs are opaque strings — always look a record up with a list_ or get_ tool before " +
        "updating or deleting it, and never invent an ID. Money fields are plain numbers in the " +
        "organization's currency. Dates use YYYY-MM-DD. When a create_ or update_ tool asks for " +
        "a 'data' object, follow the field list in that tool's description.\n\n" +
        "This company runs SEVERAL Zoho Books organizations (one per country or entity). " +
        "By default a list_ tool reads only the active organization, which is almost never " +
        "what someone means when they ask about the business.\n\n" +
        "Set all_organizations: true on the list tool whenever the question is about the " +
        "company as a whole — 'all our invoices', 'total revenue', 'who owes us money', " +
        "'company-wide', or any question that does not name one specific country or entity. " +
        "Prefer it over guessing. Use organization_ids to cover a named subset instead.\n\n" +
        "Money owed TO the company lives in invoices; money the company OWES lives in bills " +
        "(supplier invoices) and vendor_payments. Credit notes reduce revenue and vendor " +
        "credits reduce spend — include them when reporting net figures, or say that you have " +
        "not. Use group_by for breakdowns: 'customer' for top clients, 'vendor' for supplier " +
        "spend, 'month' for trends, and 'aging' for a receivables or payables ageing report. " +
        "group_by returns complete figures regardless of volume.\n\n" +
        "For any question asking HOW MUCH, HOW MANY, a TOTAL, REVENUE or OUTSTANDING amount, " +
        "set summarize: true as well. The server then reads every page and returns complete " +
        "aggregates — sums per currency, counts per status, per organization. Listing raw " +
        "records to add up yourself hits the response limit and produces figures that are " +
        "silently incomplete. Summary responses carry figures_are_complete; if it is false, " +
        "say so rather than presenting the numbers as final.\n\n" +
        "Merged results tag every record with _organization_name and _currency_code, and " +
        "include per-organization counts. Organizations use DIFFERENT CURRENCIES: never add " +
        "amounts across them without conversion. Report per-organization subtotals with their " +
        "currency, and only give a combined figure if the user supplies exchange rates or all " +
        "organizations share one currency. Always say which organizations an answer covers.\n\n" +
        "Every read goes through ZohoBooks_list with a module parameter; ZohoBooks_describe_module shows a module's fields before writing. If a single-organization result looks unexpectedly empty, do not report 'you have " +
        "none' — call ZohoBooks_list_organizations to see what exists, then retry with " +
        "all_organizations: true. ZohoBooks_set_default_organization changes which one is " +
        "active for single-organization calls.",
    }
  );

  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.name, description: t.description, inputSchema: t.schema },
      async (args, extra) => {
        const userId = extra?.authInfo?.extra?.userId;
        if (!userId) {
          return {
            content: [
              {
                type: "text",
                text:
                  "No linked Zoho account for this session. Disconnect and reconnect the " +
                  "Zoho Books app in ChatGPT to sign in with Zoho.",
              },
            ],
            isError: true,
          };
        }
        try {
          return await t.run(args ?? {}, userId);
        } catch (err) {
          return {
            content: [{ type: "text", text: `Tool "${t.name}" failed: ${err.message}` }],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

const app = express();
// Railway and most hosts sit the app behind a reverse proxy which sets X-Forwarded-For.
// Trusting one hop lets express-rate-limit (used by the OAuth routes) identify callers.
app.set("trust proxy", 1);
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`[http] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

const oauthProvider = new ZohoOAuthProvider({ publicUrl: PUBLIC_URL });
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: ["zoho_books"],
    resourceName: "Zoho Books",
  })
);

// Zoho sends the human back here after they consent.
app.get("/zoho/callback", zohoCallbackHandler(oauthProvider));

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    `Zoho Books MCP server (multi-tenant) is running.\n\n` +
      `MCP endpoint : POST /mcp\n` +
      `Tools loaded : ${tools.length}${READ_ONLY ? " (read-only mode)" : ""}\n` +
      `Health check : GET /health\n\n` +
      `Add the /mcp URL as a custom connector in ChatGPT (Authentication: OAuth).\n` +
      `Each person signs in with their own Zoho account.\n`
  );
});

app.get("/health", async (_req, res) => {
  try {
    const users = await db.listUsers();
    res.json({ status: "ok", tools: tools.length, readOnly: READ_ONLY, linkedUsers: users.length });
  } catch (err) {
    res.status(500).json({ status: "degraded", error: err.message });
  }
});

app.post("/mcp", requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl }), async (req, res) => {
  const server = createMcpServer();
  // Plain JSON responses rather than SSE: each request gets its own transport, so there is
  // no server-initiated stream to hold open, and the SSE path stalled on large payloads.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal server error: ${err.message}` },
        id: req.body?.id ?? null,
      });
    }
  }
});

// Stateless mode has no server-initiated stream to attach to.
const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
    id: null,
  });

app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// ---------------------------------------------------------------------------

try {
  await db.migrate();
  console.log("[db] schema ready");
} catch (err) {
  console.error(`\n[FATAL] Could not connect to Postgres: ${err.message}`);
  console.error(`        Check DATABASE_URL.\n`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`Zoho Books MCP server (multi-tenant) listening on port ${PORT}`);
  console.log(`  tools       : ${tools.length}${READ_ONLY ? " (read-only mode)" : ""}`);
  console.log(`  public url  : ${PUBLIC_URL}`);
  console.log(`  zoho callback: ${PUBLIC_URL}/zoho/callback`);
  console.log(
    `  allowed domains: ${process.env.ALLOWED_EMAIL_DOMAINS || "(any — set ALLOWED_EMAIL_DOMAINS to restrict)"}`
  );
});

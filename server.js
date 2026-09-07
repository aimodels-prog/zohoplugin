import express from "express";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import tools from "./tools.js";
import { READ_ONLY, VERSION, BUILD_ID, integerSetting } from "./security.js";
import * as db from "./db.js";
import { ZohoOAuthProvider, zohoCallbackHandler } from "./oauth.js";
import instructions from "./instructions.js";

export function createMcpServer() {
  const server = new McpServer({ name: "zoho-books", version: VERSION }, { instructions });
  for (const tool of tools) {
    server.registerTool(tool.name, { title: tool.name, description: tool.description, inputSchema: z.object(tool.schema).strict(),
      annotations: tool.annotations }, async (args, extra) => {
      const userId = extra?.authInfo?.extra?.userId;
      if (!userId) return { content: [{ type: "text", text: "Reconnect your Zoho account" }], isError: true };
      try { return await tool.run(args, userId); }
      catch (error) {
        const ref = crypto.randomUUID();
        console.error("[tool] failed", { ref, tool: tool.name, type: error.name });
        // Validation errors are authored locally. Never expose database/transport details.
        const safeMessage = error.name === "Error" && !error.code && !error.cause
          ? error.message : "Operation could not complete; no result was verified";
        return { content: [{ type: "text", text: safeMessage + " (reference " + ref + ")" }], isError: true };
      }
    });
  }
  return server;
}
export function validatePublicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("PUBLIC_URL requires HTTPS");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("PUBLIC_URL must be an origin");
  return url.origin;
}
export function createApp(publicUrl) {
  publicUrl = validatePublicUrl(publicUrl);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", integerSetting("TRUST_PROXY_HOPS", 1, 0, 5));
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use((req,res,next) => {
    const start = Date.now();
    res.on("finish", () => console.log("[http]", req.method, req.path, res.statusCode, Date.now() - start));
    next();
  });
  const provider = new ZohoOAuthProvider({ publicUrl });
  const resourceServerUrl = new URL(publicUrl + "/mcp");
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(publicUrl), resourceServerUrl, scopesSupported: ["zoho_books"], resourceName: "Zoho Books" }));
  app.get("/zoho/callback", zohoCallbackHandler(provider));
  app.get("/", (_req,res) => res.type("text/plain").send("Zoho Books MCP " + VERSION + "\nOAuth endpoint: POST /mcp\n"));
  app.get("/health", async (_req,res) => {
    try { await db.health(); res.json({ status: "ok", version: VERSION, build_id: BUILD_ID, tools: tools.length, readOnly: READ_ONLY }); }
    catch { res.status(503).json({ status: "degraded" }); }
  });
  const active = new Map();
  app.post("/mcp", requireBearerAuth({ verifier: provider, resourceMetadataUrl }), async (req,res) => {
    const user = req.auth.extra.userId;
    if ((active.get(user) || 0) >= 2) return res.status(429).json({ error: "Too many concurrent requests" });
    active.set(user, (active.get(user) || 0) + 1);
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (error) {
      console.error("[mcp] failed", { type: error.name });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: req.body?.id ?? null });
    } finally {
      const count = (active.get(user) || 1) - 1;
      if (count) active.set(user, count); else active.delete(user);
    }
  });
  for (const method of ["get", "delete"]) app[method]("/mcp", (_req,res) => res.status(405).json({ error: "Use POST /mcp" }));
  app.use((error,_req,res,_next) => res.status(error.status === 413 ? 413 : 400).json({ error: "Invalid request" }));
  return app;
}
async function main() {
  const missing = ["ZOHO_CLIENT_ID","ZOHO_CLIENT_SECRET","PUBLIC_URL","DATABASE_URL","TOKEN_ENCRYPTION_KEY"].filter(k => !process.env[k]);
  if (missing.length) throw new Error("Missing configuration: " + missing.join(", "));
  const app = createApp(process.env.PUBLIC_URL);
  await db.migrate();
  const server = app.listen(integerSetting("PORT", 8080, 1, 65535), () => console.log("Zoho Books MCP", VERSION, BUILD_ID, "tools:", tools.length));
  server.requestTimeout = 240000;
  server.headersTimeout = 30000;
  const timer = setInterval(() => db.cleanup().catch(() => console.error("[db] cleanup failed")), 3600000);
  timer.unref();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    clearInterval(timer);
    server.close(() => db.close().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error("[startup] failed", error.code ? "Check database connectivity and TLS" : error.message); process.exit(1); });
}

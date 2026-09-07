import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test("Postgres migration, OAuth, report isolation, MCP and write lifecycle", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  // Only an explicitly supplied disposable test database is touched.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_SSL = "false";
  process.env.TOKEN_ENCRYPTION_KEY = "34".repeat(32);
  process.env.ZOHO_READ_ONLY = "false";
  process.env.ZOHO_CLIENT_ID = "synthetic-client";
  process.env.ZOHO_CLIENT_SECRET = "synthetic-secret";
  process.env.ALLOWED_EMAIL_DOMAINS = "example.test";
  const db = await import("../db.js");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const { default: tools } = await import("../tools.js");
  const { z } = await import("zod");
  const { ZohoOAuthProvider, zohoCallbackHandler } = await import("../oauth.js");
  const { createApp } = await import("../server.js");
  const originalFetch = global.fetch;
  let server;
  const call = async (name, args, userId = "test-user") => {
    const tool = tools.find(t => t.name === "ZohoBooks_" + name);
    return tool.run(z.object(tool.schema).strict().parse(args), userId);
  };
  const payload = result => JSON.parse(result.content[0].text);
  try {
    await db.migrate();
    await db.upsertUser({ id: "test-user", zuid: "123", email: "finance@example.test", refreshToken: "synthetic-refresh", accountsServer: "https://accounts.zoho.com", apiDomain: "https://www.zohoapis.com", defaultOrgId: "om" });
    await db.upsertUser({ id: "other-user", zuid: "456", email: "other@example.test", refreshToken: "other-refresh", accountsServer: "https://accounts.zoho.com", apiDomain: "https://www.zohoapis.com", defaultOrgId: "om" });
    const encrypted = await pool.query("SELECT zoho_refresh_token FROM users WHERE id='test-user'");
    assert.match(encrypted.rows[0].zoho_refresh_token, /^enc:v1:/);
    assert.equal((await db.getUser("test-user")).zoho_refresh_token, "synthetic-refresh");
    // Exercise the actual legacy-data upgrade and verify it is idempotent.
    await pool.query("UPDATE users SET zoho_refresh_token='legacy-refresh' WHERE id='test-user'");
    await pool.query("INSERT INTO oauth_tokens(token,kind,client_id,user_id) VALUES('legacy-token','refresh','c','test-user')");
    await db.migrate(); await db.migrate();
    assert.equal((await db.getUser("test-user")).zoho_refresh_token, "legacy-refresh");
    assert.ok(await db.getToken("legacy-token"));
    assert.equal((await pool.query("SELECT count(*) FROM oauth_tokens WHERE token='legacy-token'")).rows[0].count, "0");
    await db.saveClient({ client_id: "c", client_secret: "client-secret", redirect_uris: ["https://client.example.test/callback"] });
    assert.equal((await db.getClient("c")).client_secret, "client-secret");
    assert.match((await pool.query("SELECT metadata FROM oauth_clients WHERE client_id='c'")).rows[0].metadata.client_secret, /^enc:v1:/);

    const provider = new ZohoOAuthProvider({ publicUrl: "https://mcp.example.test" });
    const issued = await provider._issue("c", "test-user", ["zoho_books"], "https://mcp.example.test/mcp");
    const rotated = await provider.exchangeRefreshToken({ client_id: "c" }, issued.refresh_token);
    assert.notEqual(rotated.refresh_token, issued.refresh_token);
    await assert.rejects(provider.exchangeRefreshToken({ client_id: "c" }, issued.refresh_token));
    await assert.rejects(provider.exchangeRefreshToken({ client_id: "c" }, rotated.refresh_token, ["other_scope"]));
    await provider.revokeToken({ client_id: "different" }, { token: rotated.access_token });
    assert.ok(await db.getToken(rotated.access_token));
    await provider.revokeToken({ client_id: "c" }, { token: rotated.access_token });
    assert.equal(await db.getToken(issued.access_token), null);
    assert.equal(await db.getToken(rotated.refresh_token), null);
    const atomic = await provider._issue("c", "test-user", ["zoho_books"], "https://mcp.example.test/mcp");
    await assert.rejects(db.issueTokenPair({ accessToken: atomic.access_token, refreshToken: "replacement", clientId: "c", userId: "test-user", scopes: ["zoho_books"], resource: "https://mcp.example.test/mcp", oldRefresh: atomic.refresh_token }));
    assert.ok(await db.getToken(atomic.refresh_token), "failed issuance must roll back consumption");

    let writes = 0; let currentName = "Original";
    global.fetch = async (url, options = {}) => {
      url = new URL(url);
      if (url.hostname === "127.0.0.1") return originalFetch(url, options);
      if (url.pathname.endsWith("/oauth/v2/token")) return Response.json({ access_token: "synthetic-access", expires_in: 3600 });
      if (url.pathname.endsWith("/organizations")) return Response.json({ code: 0, organizations: [{ organization_id: "om", name: "Oman", currency_code: "OMR" }] });
      if (url.pathname.endsWith("/customerpayments")) return Response.json({ code: 0, customer_payments: [
        { payment_id: "1", date: "2026-08-01", amount: "200", bcy_amount: "80.123" },
        { payment_id: "2", date: "2026-08-31", currency_code: "OMR", amount: "1.234", bcy_amount: "1.234" },
      ], page_context: { has_more_page: false } });
      if ((options.method || "GET") !== "GET") { writes++; return Response.json({ code: 0, contact: { contact_id: "1", contact_name: "Created" } }); }
      return Response.json({ code: 0, contact: { contact_id: "1", contact_name: currentName } });
    };
    const summary = payload(await call("collections_report", { organization_id: "om", date_start: "2026-08-01", date_end: "2026-08-31" }));
    assert.equal(summary.totals[0].amount.exact, "81.357");
    assert.equal(summary.record_count, 2);
    assert.equal(await db.getReport(summary.report_id, "other-user"), null);
    assert.equal(payload(await call("get_report", { report_id: summary.report_id, section: "evidence" })).data.length, 2);
    const compared = payload(await call("reconcile_report", { report_id: summary.report_id, reference_label: "Synthetic test fixture, not finance data", records: [
      { organization_id: "om", record_id: "1", currency: "OMR", amount: "80.123" },
      { organization_id: "om", record_id: "2", currency: "OMR", amount: "1.234" },
    ] }));
    assert.equal(compared.status, "matches_supplied_reference");
    const snapshot = await db.getReport(summary.report_id, "test-user");
    await db.saveReport(summary.report_id, "test-user", snapshot.payload, snapshot.revision);
    await assert.rejects(db.saveReport(summary.report_id, "test-user", snapshot.payload, snapshot.revision));
    const rawId = randomUUID();
    const huge = { text: '\\"\n'.repeat(6000) };
    await db.saveReport(rawId, "test-user", { kind: "raw", value: huge });
    process.env.MAX_RESPONSE_CHARS = "4000";
    let offset = 0, combined = "";
    do {
      const part = await call("get_report", { report_id: rawId, section: "raw", offset });
      assert.ok(part.content[0].text.length <= 4000);
      const fragment = payload(part); combined += fragment.fragment; offset = fragment.next_offset;
    } while (offset !== undefined);
    assert.deepEqual(JSON.parse(combined).data, huge);
    delete process.env.MAX_RESPONSE_CHARS;

    const preview = payload(await call("create", { module: "contacts", organization_id: "om", idempotency_key: randomUUID(), data: { contact_name: "Created" } }));
    assert.equal(writes, 0);
    const confirmed = payload(await call("confirm_write", { operation_id: preview.operation_id, user_confirmed: true }));
    assert.equal(confirmed.state, "completed");
    await call("confirm_write", { operation_id: preview.operation_id, user_confirmed: true });
    assert.equal(writes, 1);
    assert.equal((await call("confirm_write", { operation_id: preview.operation_id, user_confirmed: true }, "other-user")).isError, true);
    const update = payload(await call("update", { module: "contacts", organization_id: "om", record_id: "1", idempotency_key: randomUUID(), data: { contact_name: "Changed" } }));
    currentName = "Externally changed";
    assert.equal((await call("confirm_write", { operation_id: update.operation_id, user_confirmed: true })).isError, true);
    assert.equal(writes, 1);
    const operationId = randomUUID();
    await db.saveWrite(operationId, "test-user", randomUUID(), {});
    const claims = await Promise.all([db.claimWrite(operationId, "test-user"), db.claimWrite(operationId, "test-user")]);
    assert.equal(claims.filter(Boolean).length, 1);

    let callbackStatus;
    await zohoCallbackHandler(provider)({ query: { code: "code", state: "state", "accounts-server": "https://evil.test" } }, {
      status(code) { callbackStatus = code; return this; }, type() { return this; }, send() { return this; },
    });
    assert.equal(callbackStatus, 500);

    const app = createApp("http://127.0.0.1:8080");
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    const localProvider = new ZohoOAuthProvider({ publicUrl: "http://127.0.0.1:8080" });
    const auth = await localProvider._issue("c", "test-user", ["zoho_books"], "http://127.0.0.1:8080/mcp");
    assert.equal((await originalFetch(origin + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const mcp = await originalFetch(origin + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + auth.access_token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(mcp.status, 200);
    const listed = await mcp.json();
    assert.ok(listed.result.tools.some(t => t.name === "ZohoBooks_collections_report"));
    const invalidCall = await originalFetch(origin + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + auth.access_token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ZohoBooks_collections_report", arguments: { organization_id: "om", date_start: "2026-08-01", date_end: "2026-08-31", filter_by: "ignored-filter" } } }) });
    const invalidResult = await invalidCall.json();
    assert.ok(invalidResult.error || invalidResult.result?.isError);
    await db.cleanup();
  } finally {
    global.fetch = originalFetch;
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end(); await db.close();
  }
});

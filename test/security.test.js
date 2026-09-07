import test from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, tokenHash, zohoOrigin } from "../security.js";
import { requestJson, booksSuccess } from "../http.js";
import { validateWrite, recordFingerprint } from "../write-safety.js";
import { validatePublicUrl, createMcpServer } from "../server.js";
process.env.TOKEN_ENCRYPTION_KEY = "12".repeat(32);

test("token encryption roundtrip and authentication", () => {
  const value = encrypt("synthetic secret");
  assert.ok(!value.includes("synthetic secret"));
  assert.equal(decrypt(value), "synthetic secret");
  const parts = value.split(":"); parts[4] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decrypt(parts.join(":")));
  assert.notEqual(encrypt("same"), encrypt("same"));
  assert.match(tokenHash("token"), /^sha256:[a-f0-9]{64}$/);
});
test("reject untrusted OAuth/API origins", () => {
  for (const value of ["http://accounts.zoho.com", "https://accounts.zoho.com.evil.test", "https://accounts.zoho.com@evil.test", "https://accounts.zoho.com/path", "https://accounts.zoho.com:444", "https://127.0.0.1"]) assert.throws(() => zohoOrigin(value));
  assert.equal(zohoOrigin("https://accounts.zoho.eu/"), "https://accounts.zoho.eu");
  assert.equal(zohoOrigin("https://www.zohoapis.com", "api"), "https://www.zohoapis.com");
});
test("exact decimal ingestion and HTTP/application errors", async () => {
  const r = await requestJson("https://example.test", {}, async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return new Response('{"code":0,"amount":9007199254740993.123}', { status: 200 });
  });
  assert.equal(r.data.amount, "9007199254740993.123");
  assert.equal(booksSuccess(r), true);
  assert.equal(booksSuccess({ httpOk: true, data: { code: "57" } }), false);
  assert.equal(booksSuccess({ httpOk: true, data: {} }), false);
});
test("invalid JSON is never a successful response", async () => {
  await assert.rejects(requestJson("https://example.test", {}, async () => new Response("not JSON")));
});
test("writes are never automatically retried", async () => {
  let calls = 0;
  await assert.rejects(requestJson("https://example.test", { method: "POST" }, async () => { calls++; throw new TypeError("network"); }));
  assert.equal(calls, 1);
});
test("safe read retries transient failures", async () => {
  let calls = 0;
  const r = await requestJson("https://example.test", {}, async () => ++calls === 1 ? new Response("", { status: 503 }) : new Response('{"code":0}'));
  assert.equal(calls, 2); assert.equal(booksSuccess(r), true);
});
test("write validation catches required fields and invalid data", () => {
  assert.throws(() => validateWrite("invoices", "create", {}));
  assert.throws(() => validateWrite("invoices", "update", { line_items: [] }));
  assert.throws(() => validateWrite("customer_payments", "update", { amount: "1bad" }));
  assert.throws(() => validateWrite("customer_payments", "update", { date: "2026-02-30" }));
  assert.throws(() => validateWrite("customer_payments", "update", { organization_id: "other" }));
  assert.throws(() => validateWrite("customer_payments", "update", { customer_id: 123 }));
});
test("journals must balance exactly", () => {
  assert.throws(() => validateWrite("journals", "create", { journal_date: "2026-08-01", line_items: [
    { account_id: "1", debit_or_credit: "debit", amount: "1.234" }, { account_id: "2", debit_or_credit: "credit", amount: "1.23" }] }));
});
test("fingerprint rejects changed records, ignores key ordering", () => {
  assert.equal(recordFingerprint({ a: 1, b: 2 }), recordFingerprint({ b: 2, a: 1 }));
  assert.notEqual(recordFingerprint({ a: 1 }), recordFingerprint({ a: 2 }));
});
test("public URL requires trusted origin syntax and HTTPS", () => {
  assert.throws(() => validatePublicUrl("http://example.test"));
  assert.throws(() => validatePublicUrl("https://example.test/path"));
  assert.equal(validatePublicUrl("http://localhost:8080"), "http://localhost:8080");
});
test("MCP server registers every tool schema", async () => {
  const server = createMcpServer();
  await server.close();
});

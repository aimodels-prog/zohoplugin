import test from "node:test";
import assert from "node:assert/strict";
import { createSnapshot, advanceSnapshot, calculate } from "../reporting.js";
import { MODULES } from "../modules.js";
const orgs = [{ organization_id: "om", name: "Oman", currency_code: "OMR" }];
const spec = { kind: "receivables", module: "contacts", metric: "outstanding_receivable_amount", currency_basis: "base", group_by: "customer" };
const contact = (id, extra = {}) => ({ contact_id: id, contact_name: id, contact_type: "customer", currency_code: "OMR", outstanding_receivable_amount: "12.345", status: "active", ...extra });
const page = rows => ({ ok: true, data: { contacts: rows, page_context: { has_more_page: false } } });
async function run(rows, overrides = {}) {
  const s = createSnapshot({ ...spec, ...overrides }, orgs);
  await advanceSnapshot(s, MODULES.contacts, async req => {
    assert.equal(req.query.contact_type, "customer"); assert.equal(req.query.filter_by, "Status.All");
    return page(rows);
  });
  return calculate(s, MODULES.contacts);
}
test("native customer receivables include inactive customers and do not subtract unused credits", async () => {
  const r = await run([contact("a", { status: "inactive", unused_credits_receivable_amount: "500" }), contact("b", { outstanding_receivable_amount: "30" })]);
  assert.equal(r.summary.totals[0].amount.exact, "42.345");
  assert.equal(r.groups[0].group_id, "b"); assert.equal(r.groups[0].rank_in_organization_currency, 1);
  assert.equal(r.evidence[0].customer_id, "a"); assert.match(r.summary.definition, /Unused credits are not independently subtracted/);
});
test("native base amount uses Zoho's suffix field, never an invented conversion", async () => {
  const r = await run([contact("eur", { currency_code: "EUR", outstanding_receivable_amount: "100", outstanding_receivable_amount_bcy: "41.234", exchange_rate: "999" })]);
  assert.equal(r.summary.totals[0].amount.exact, "41.234");
  assert.equal(r.evidence[0].amount_source, "outstanding_receivable_amount_bcy");
});
test("foreign base details resume within the request budget and are read again in verification", async () => {
  let s = createSnapshot(spec, orgs); const paths = [];
  const read = async req => {
    paths.push(req.path);
    return req.path === "/contacts" ? page([contact("eur", { currency_code: "EUR" })]) :
      { ok: true, data: { contact: contact("eur", { currency_code: "EUR", outstanding_receivable_amount_bcy: "5.123" }) } };
  };
  for (let i = 0; i < 4; i++) {
    await advanceSnapshot(s, MODULES.contacts, read, 1);
    s = JSON.parse(JSON.stringify(s));
    assert.equal(calculate(s, MODULES.contacts).summary.figures_are_complete, i === 3);
  }
  assert.deepEqual(paths, ["/contacts", "/contacts/eur", "/contacts", "/contacts/eur"]);
  assert.equal(calculate(s, MODULES.contacts).summary.totals[0].amount.exact, "5.123");
});
test("unavailable foreign base amount invalidates a report even after detail retrieval", async () => {
  const s = createSnapshot(spec, orgs);
  const row = contact("eur", { currency_code: "EUR", exchange_rate: "0.4" });
  await advanceSnapshot(s, MODULES.contacts, async req => req.path === "/contacts" ? page([structuredClone(row)]) : { ok: true, data: { contact: row } });
  const r = calculate(s, MODULES.contacts);
  assert.equal(r.summary.totals, null); assert.match(r.validation_errors[0].error, /Recorded base amount missing/);
});
test("incorrect customer detail identity is rejected", async () => {
  const s = createSnapshot(spec, orgs);
  await advanceSnapshot(s, MODULES.contacts, async req => req.path === "/contacts" ? page([contact("eur", { currency_code: "EUR" })]) : { ok: true, data: { contact: contact("different") } });
  assert.equal(calculate(s, MODULES.contacts).summary.totals, null);
  assert.match(s.organizations[0].errors[0], /identity/);
});
test("a repeatedly changing recorded customer base balance never yields a ranking", async () => {
  const s = createSnapshot(spec, orgs); let details = 0;
  await advanceSnapshot(s, MODULES.contacts, async req => req.path === "/contacts" ? page([contact("eur", { currency_code: "EUR" })]) :
    { ok: true, data: { contact: contact("eur", { currency_code: "EUR", outstanding_receivable_amount_bcy: String(++details) }) } });
  const r = calculate(s, MODULES.contacts);
  assert.equal(details, 4); assert.equal(r.summary.totals, null); assert.deepEqual(r.groups, []);
  assert.ok(r.summary.organizations[0].verification_failures[1].samples[0].fields.includes("outstanding_receivable_amount_bcy"));
});
test("contact type is checked locally and missing balance never becomes zero", async () => {
  const r = await run([contact("vendor", { contact_type: "vendor" }), contact("a")]);
  assert.equal(r.summary.record_count, 1); assert.equal(r.summary.excluded_count, 1);
  assert.equal((await run([contact("a", { outstanding_receivable_amount: undefined })])).summary.totals, null);
  assert.equal((await run([contact("a", { contact_type: undefined })])).summary.totals, null);
});
test("native transaction balances and ranking remain separate for each currency", async () => {
  const r = await run([contact("om"), contact("eur", { currency_code: "EUR", outstanding_receivable_amount: "1000" })], { currency_basis: "transaction" });
  assert.equal(r.summary.totals.length, 2);
  assert.ok(r.groups.every(g => g.rank_in_organization_currency === 1));
});
test("customer filter uses the contact ID and historical/unsupported filters are rejected", async () => {
  assert.equal((await run([contact("a"), contact("b")], { customer_id: "a" })).summary.record_count, 1);
  for (const options of [{ as_of: "2026-08-31" }, { date_start: "2026-08-01", date_end: "2026-08-31" }, { statuses: ["active"] }, { search_text: "x" }, { kind: "source_field" }]) assert.throws(() => createSnapshot({ ...spec, ...options }, orgs));
});

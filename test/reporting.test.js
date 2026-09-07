import test from "node:test";
import assert from "node:assert/strict";
import { money, validDate, validateRange, selectOrganizations, createSnapshot, advanceSnapshot, calculate, agingBucket, extractRows, reconcileEvidence } from "../reporting.js";
import { MODULES } from "../modules.js";

const module = MODULES.customer_payments;
const orgs = [{ organization_id: "om", name: "Oman", currency_code: "OMR" }];
const spec = { kind: "collections", module: "customer_payments", metric: "amount", currency_basis: "base", date_start: "2026-08-01", date_end: "2026-08-31" };
const row = (id, extra = {}) => ({ payment_id: id, date: "2026-08-15", amount: "1.234", bcy_amount: "1.234", currency_code: "OMR", ...extra });
async function report(rows, options = {}) {
  const snap = createSnapshot({ ...spec, ...options }, orgs);
  await advanceSnapshot(snap, module, async () => ({ ok: true, data: { customer_payments: rows, page_context: { has_more_page: false } } }));
  return calculate(snap, module);
}
test("OMR sums preserve three decimals", async () => {
  const r = await report([row("1"), row("2", { amount: "2.345", bcy_amount: "2.345" })]);
  assert.equal(r.summary.totals[0].amount.exact, "3.579");
  assert.equal(r.summary.totals[0].amount.formatted, "3.579");
});
test("foreign payment uses recorded base amount without assuming its currency", async () => {
  const r = await report([row("1", { amount: "100", bcy_amount: "100" }), row("2", { amount: "200", bcy_amount: "80", currency_code: undefined })]);
  assert.equal(r.summary.totals[0].amount.exact, "180");
  assert.equal(r.evidence[1].amount_source, "bcy_amount");
});
test("missing transaction currency never defaults to OMR", async () => {
  const r = await report([row("1", { currency_code: undefined })], { currency_basis: "transaction" });
  assert.equal(r.summary.figures_are_complete, false);
  assert.equal(r.summary.totals, null);
});
test("no invented conversion when foreign base amount missing", async () => {
  const r = await report([row("1", { currency_code: "EUR", bcy_amount: undefined, exchange_rate: "0.4" })]);
  assert.equal(r.summary.totals, null);
});
test("same-currency fallback is explicit", async () => {
  const r = await report([row("1", { bcy_amount: undefined })]);
  assert.equal(r.summary.totals[0].amount.exact, "1.234");
});
test("decimal parsing rejects malformed or missing values", () => {
  for (const v of [undefined, null, "123invalid", "1,234", "", "NaN", Infinity]) assert.throws(() => money(v));
  assert.equal(money("9007199254740993.123").plus("0.001").toFixed(), "9007199254740993.124");
});
test("missing amounts invalidate entire total", async () => {
  const r = await report([row("1", { amount: undefined, bcy_amount: undefined })]);
  assert.equal(r.summary.record_count, null);
  assert.equal(r.summary.validation_error_count, 1);
});
test("inclusive local date boundaries and exclusions", async () => {
  const r = await report([row("1", { date: "2026-07-31" }), row("2", { date: "2026-08-01" }), row("3", { date: "2026-08-31" }), row("4", { date: "2026-09-01" })]);
  assert.equal(r.summary.record_count, 2);
  assert.equal(r.summary.excluded_count, 2);
});
test("invalid date cannot be silently excluded", async () => {
  const r = await report([row("1", { date: "2026-02-30" })]);
  assert.equal(r.summary.figures_are_complete, false);
  assert.equal(validDate("2026-02-30"), false);
  assert.throws(() => validateRange("2026-09-01", "2026-08-01"));
});
test("organization scope must be explicit and fully accessible", () => {
  assert.throws(() => selectOrganizations(orgs, {}));
  assert.throws(() => selectOrganizations(orgs, { organization_ids: [] }));
  assert.throws(() => selectOrganizations(orgs, { organization_ids: ["om", "missing"] }));
  assert.throws(() => selectOrganizations(orgs, { organization_id: "om", all_organizations: true }));
});
test("unexpected array/shape is rejected", () => {
  assert.throws(() => extractRows({ notes: [] }, "customer_payments"));
  assert.throws(() => extractRows({ customer_payments: [null] }, "customer_payments"));
});
test("malformed response never becomes a complete empty report", async () => {
  const snap = createSnapshot(spec, orgs);
  await advanceSnapshot(snap, module, async () => ({ ok: true, data: { unexpected: [] } }));
  assert.equal(calculate(snap, module).summary.totals, null);
  assert.equal(snap.organizations[0].blocked, true);
});
test("missing pagination fetches another page and verifies both", async () => {
  const snap = createSnapshot(spec, orgs); const calls = [];
  await advanceSnapshot(snap, module, async req => {
    calls.push(req.query.page);
    return { ok: true, data: { customer_payments: req.query.page === 1 ? [row("1")] : [], page_context: null } };
  });
  assert.deepEqual(calls, [1, 2, 1, 2]);
  assert.equal(calculate(snap, module).summary.record_count, 1);
});
test("duplicate pages invalidate report", async () => {
  const snap = createSnapshot(spec, orgs);
  await advanceSnapshot(snap, module, async () => ({ ok: true, data: { customer_payments: [row("1")], page_context: { has_more_page: true } } }));
  assert.equal(calculate(snap, module).summary.totals, null);
  assert.match(snap.organizations[0].errors[0], /duplicate/);
});
test("pagination budget resumes instead of reporting a partial final total", async () => {
  const snap = createSnapshot(spec, orgs);
  const read = async req => ({ ok: true, data: { customer_payments: [row(String(req.query.page))], page_context: { has_more_page: req.query.page < 3 } } });
  await advanceSnapshot(snap, module, read, 1);
  assert.equal(calculate(snap, module).summary.totals, null);
  assert.equal(calculate(snap, module).summary.continuation_available, true);
  await advanceSnapshot(snap, module, read, 10);
  assert.equal(calculate(snap, module).summary.record_count, 3);
});
test("changes on verification pass invalidate result", async () => {
  const snap = createSnapshot(spec, orgs); let calls = 0;
  await advanceSnapshot(snap, module, async () => ({ ok: true, data: { customer_payments: [row("1", { amount: String(++calls) })], page_context: { has_more_page: false } } }));
  assert.equal(calculate(snap, module).summary.totals, null);
  assert.match(snap.organizations[0].errors[0], /changed/);
});
test("network failure is retriable and not zero", async () => {
  const snap = createSnapshot(spec, orgs);
  await advanceSnapshot(snap, module, async () => { throw new Error("network"); });
  assert.equal(calculate(snap, module).summary.totals, null);
  await advanceSnapshot(snap, module, async () => ({ ok: true, data: { customer_payments: [], page_context: { has_more_page: false } } }));
  assert.equal(calculate(snap, module).summary.record_count, 0);
});
test("groups use IDs and are never cut off at 300", async () => {
  const records = Array.from({ length: 350 }, (_, i) => row(String(i), { customer_id: String(i), customer_name: "Same name" }));
  const r = await report(records, { group_by: "customer" });
  assert.equal(r.groups.length, 350);
  assert.equal(r.summary.record_count, 350);
});
test("missing group identity is explicit invalid data", async () => {
  const r = await report([row("1", { customer_name: "Acme" })], { group_by: "customer" });
  assert.equal(r.summary.totals, null);
});
test("base-currency grouping does not require transaction currency", async () => {
  const r = await report([row("1", { currency_code: undefined })], { group_by: "currency" });
  assert.equal(r.groups[0].currency, "OMR");
});
test("aging does not fabricate balance or due date", () => {
  assert.equal(agingBucket({ due_date: "2026-01-01" }, "2026-08-31"), "unknown balance");
  assert.equal(agingBucket({ balance: "10", date: "2026-01-01" }, "2026-08-31"), "unknown due date");
  assert.equal(agingBucket({ balance: "10", due_date: "2026-08-01" }, "2026-08-31"), "1-30");
});
test("unsupported financial interpretations and historical balances are rejected", () => {
  assert.throws(() => createSnapshot({ ...spec, module: "journals", metric: "total" }, orgs));
  assert.throws(() => createSnapshot({ ...spec, kind: "source_field", module: "invoices", metric: "balance", as_of: "2020-01-01" }, orgs));
});
test("report never claims reconciliation with finance", async () => {
  const r = await report([row("1")]);
  assert.equal(r.summary.reconciliation_status, "not_reconciled_with_finance");
  assert.match(r.summary.definition, /Refunds, fees/);
});
test("reconciliation requires all IDs, currencies and exact amounts", async () => {
  const r = await report([row("1")]);
  const refs = [{ organization_id: "om", record_id: "1", currency: "OMR", amount: "1.234" }];
  assert.equal(reconcileEvidence(r.evidence, refs).status, "matches_supplied_reference");
  assert.equal(reconcileEvidence(r.evidence, [{ ...refs[0], amount: "1.23" }]).status, "differs_from_supplied_reference");
  assert.equal(reconcileEvidence(r.evidence, [{ ...refs[0], record_id: "other" }]).differences.length, 2);
  assert.throws(() => reconcileEvidence(r.evidence, [...refs, ...refs]));
});
test("multi-organization totals keep currency and identity separate", async () => {
  const snap = createSnapshot(spec, [...orgs, { organization_id: "eu", name: "Europe", currency_code: "EUR" }]);
  await advanceSnapshot(snap, module, async req => ({ ok: true, data: { customer_payments: [row("same-id", { bcy_amount: req.query.organization_id === "om" ? "1.234" : "2.34" })], page_context: { has_more_page: false } } }));
  const r = calculate(snap, module);
  assert.equal(r.summary.totals.length, 2);
  assert.deepEqual(r.summary.totals.map(t => t.currency), ["OMR", "EUR"]);
});
test("one inaccessible organization prevents a group-wide final total", async () => {
  const snap = createSnapshot(spec, [...orgs, { organization_id: "eu", name: "Europe", currency_code: "EUR" }]);
  await advanceSnapshot(snap, module, async req => req.query.organization_id === "eu" ? { ok: false, text: "Permission denied" } : { ok: true, data: { customer_payments: [row("1")], page_context: { has_more_page: false } } });
  assert.equal(calculate(snap, module).summary.totals, null);
});
test("known status filters exclude explicitly; unknown status filters fail", async () => {
  assert.throws(() => createSnapshot({ ...spec, statuses: ["not-a-real-status"] }, orgs));
  assert.throws(() => createSnapshot({ ...spec, kind: "source_field", module: "invoices", metric: "balance", statuses: ["outstanding"] }, orgs));
});
test("party filter cannot turn missing IDs into zero", async () => {
  const r = await report([row("1")], { customer_id: "customer" });
  assert.equal(r.summary.totals, null);
  assert.match(r.validation_errors[0].error, /Missing party/);
});
test("unsupported currency codes do not yield verified totals", async () => {
  const r = await report([row("1", { currency_code: "BAD" })], { currency_basis: "transaction" });
  assert.equal(r.summary.totals, null);
});

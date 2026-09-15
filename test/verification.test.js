import test from "node:test";
import assert from "node:assert/strict";
import { createSnapshot, advanceSnapshot, calculate } from "../reporting.js";
import { MODULES } from "../modules.js";

const orgs = [{ organization_id: "om", name: "Oman", currency_code: "OMR" }];
const spec = { kind: "source_field", module: "invoices", metric: "balance", currency_basis: "base", group_by: "customer" };
const invoice = (id, extra = {}) => ({ invoice_id: String(id), customer_id: "c" + Number(id) % 10, customer_name: "Customer " + Number(id) % 10,
  balance: "1.000", bcy_balance: "1.000", currency_code: "OMR", date: "2026-08-01", due_date: "2026-08-31", status: "sent", ...extra });
const invoices = Array.from({ length: 608 }, (_, i) => invoice(i + 1));
async function finish(snapshot, read, budget = 10, module = MODULES.invoices) {
  for (let i = 0; i < 100; i++) {
    await advanceSnapshot(snapshot, module, read, budget);
    snapshot = JSON.parse(JSON.stringify(snapshot)); // Exercise durable continuation, not in-memory Maps.
    if (!calculate(snapshot, module).summary.continuation_available) return { snapshot, ...calculate(snapshot, module) };
  }
  throw new Error("Report did not finish within its bounded test workload");
}
function pagedRead(snapshot, before, after, options = {}) {
  return async req => {
    const org = snapshot.organizations.find(o => o.id === req.query.organization_id);
    // finish() deserializes the snapshot, so callers use request counts for phase where necessary.
    const source = org.done ? after : before;
    const rows = source.slice((req.query.page - 1) * 200, req.query.page * 200);
    return { ok: true, data: { invoices: rows, page_context: { page: String(req.query.page), has_more_page: req.query.page * 200 < source.length, ...options } } };
  };
}

test("608 invoices verify despite reordering across all four page boundaries", async () => {
  const s = createSnapshot(spec, orgs); let calls = 0;
  await advanceSnapshot(s, MODULES.invoices, async req => {
    calls++;
    assert.equal(req.query.sort_column, "created_time"); assert.equal(req.query.sort_order, "A");
    const source = calls <= 4 ? invoices : [...invoices].reverse();
    return { ok: true, data: { invoices: source.slice((req.query.page - 1) * 200, req.query.page * 200), page_context: { page: String(req.query.page), has_more_page: req.query.page < 4 } } };
  });
  const r = calculate(s, MODULES.invoices);
  assert.equal(calls, 8); assert.equal(r.summary.record_count, 608);
  assert.equal(r.summary.totals[0].amount.exact, "608"); assert.equal(r.groups.length, 10);
  assert.equal(s.organizations[0].retry_count, 0);
});

test("metadata and decimal representation changes do not invalidate balances", async () => {
  const s = createSnapshot(spec, orgs);
  await advanceSnapshot(s, MODULES.invoices, pagedRead(s, [invoice(1)], [invoice(1, { balance: "1.00", bcy_balance: 1, last_modified_time: "changed", is_viewed_by_client: true, custom_fields: [{ value: "changed" }] })]));
  assert.equal(calculate(s, MODULES.invoices).summary.figures_are_complete, true);
});

test("verification independently exhausts pages when page sizes and metadata change", async () => {
  const s = createSnapshot(spec, orgs);
  await advanceSnapshot(s, MODULES.invoices, async req => {
    const verifying = s.organizations[0].done;
    const size = verifying ? 100 : 200;
    return { ok: true, data: { invoices: invoices.slice((req.query.page - 1) * size, req.query.page * size),
      page_context: verifying ? null : { has_more_page: req.query.page < 4 } } };
  }, 20);
  assert.equal(calculate(s, MODULES.invoices).summary.record_count, 608);
  assert.equal(s.organizations[0].verification_page - 1, 8); // Seven pages and an empty sentinel.
});

test("five entities resume both passes with independent ID sets and unchanged totals", async () => {
  const s = createSnapshot(spec, Array.from({ length: 5 }, (_, i) => ({ ...orgs[0], organization_id: String(i) })));
  let calls = 0;
  const r = await finish(s, async req => {
    calls++;
    return { ok: true, data: { invoices: invoices.slice((req.query.page - 1) * 200, req.query.page * 200), page_context: [{ has_more_page: req.query.page < 4 }] } };
  }, 3);
  assert.equal(calls, 40); assert.equal(r.summary.record_count, 3040);
  assert.equal(r.summary.totals.length, 5); assert.ok(r.summary.totals.every(t => t.amount.exact === "608"));
});

test("one source update recovers automatically using a fresh pair of reads", async () => {
  let calls = 0;
  const r = await finish(createSnapshot(spec, orgs), async () => ({ ok: true, data: { invoices: [invoice(1, { balance: ++calls === 1 ? "1" : "2", bcy_balance: calls === 1 ? "1" : "2" })], page_context: { has_more_page: false } } }), 1);
  assert.equal(calls, 4); assert.equal(r.summary.totals[0].amount.exact, "2");
  assert.equal(r.summary.organizations[0].retry_count, 1);
  assert.deepEqual(r.summary.organizations[0].verification_failures[0].samples[0].fields.sort(), ["balance", "bcy_balance"]);
});

for (const [field, value, options] of [
  ["balance", "2"], ["bcy_balance", "2"], ["customer_id", "other"], ["customer_name", "Renamed"], ["currency_code", "EUR"],
  ["status", "void", { statuses: ["sent"] }], ["date", "2026-09-01", { date_start: "2026-08-01", date_end: "2026-08-31" }],
  ["due_date", "2026-09-01", { group_by: "aging", as_of: new Date().toISOString().slice(0, 10) }],
  ["description", "different", { search_text: "match" }],
]) {
  test(`persistent change in report field ${field} withholds totals and identifies the field`, async () => {
    let calls = 0;
    const r = await finish(createSnapshot({ ...spec, ...options }, orgs), async () => ({ ok: true, data: {
      invoices: [invoice(1, { description: "match", ...(++calls % 2 === 0 && { [field]: value }) })], page_context: { has_more_page: false } } }), 1);
    assert.equal(r.summary.totals, null); assert.deepEqual(r.groups, []); assert.equal(calls, 4);
    assert.ok(r.summary.organizations[0].verification_failures[1].samples[0].fields.includes(field));
  });
}

for (const kind of ["added", "missing", "replaced", "duplicate", "missing_id"]) {
  test(`verification detects ${kind} IDs even when amounts are equal`, async () => {
    let calls = 0;
    const r = await finish(createSnapshot(spec, orgs), async () => {
      const rows = [invoice(1), invoice(2)];
      if (++calls % 2 === 0) {
        if (kind === "added") rows.push(invoice(3));
        if (kind === "missing") rows.pop();
        if (kind === "replaced") rows[0] = invoice(3);
        if (kind === "duplicate") rows[0] = invoice(2);
        if (kind === "missing_id") delete rows[0].invoice_id;
      }
      return { ok: true, data: { invoices: rows, page_context: { has_more_page: false } } };
    }, 1);
    assert.equal(r.summary.totals, null); assert.equal(calls, 4);
    const failure = r.summary.organizations[0].verification_failures[1];
    assert.equal(failure.code, ["duplicate", "missing_id"].includes(kind) ? "duplicate_ids" : "source_records_changed");
    if (kind === "missing") assert.equal(failure.missing_records, 1);
    if (kind === "added") assert.equal(failure.added_records, 1);
  });
}

test("a repeated page on the second pass is detected across continuations", async () => {
  let calls = 0;
  const r = await finish(createSnapshot(spec, orgs), async req => {
    calls++;
    const position = (calls - 1) % 4;
    return { ok: true, data: { invoices: [invoice(position === 3 ? 1 : req.query.page)], page_context: { has_more_page: req.query.page === 1 } } };
  }, 1);
  assert.equal(r.summary.totals, null); assert.equal(r.summary.organizations[0].verification_failures[1].code, "duplicate_ids");
});

for (const context of [{ has_more_page: "false" }, { page: 99, has_more_page: false }, { page: true }, [], "invalid"]) {
  test(`invalid second-pass pagination is rejected: ${JSON.stringify(context)}`, async () => {
    let calls = 0;
    const r = await finish(createSnapshot(spec, orgs), async () => ({ ok: true, data: { invoices: [invoice(1)], page_context: ++calls === 1 ? { has_more_page: false } : context } }));
    assert.equal(r.summary.totals, null); assert.match(r.summary.organizations[0].errors[0], /[Pp]agination/);
  });
}

test("legacy blocked snapshots restart safely instead of mixing verification methods", async () => {
  const s = createSnapshot(spec, orgs);
  delete s.verification_method;
  Object.assign(s.organizations[0], { rows: [invoice(999)], done: true, blocked: true, page_fingerprints: ["old"] });
  s.reconciliation = { status: "matches_supplied_reference" };
  const r = await finish(s, async () => ({ ok: true, data: { invoices: [invoice(1)], page_context: { has_more_page: false } } }));
  assert.equal(r.summary.record_count, 1); assert.equal(r.evidence[0].record_id, "1");
  assert.match(r.summary.restart_reason, /Upgraded/); assert.equal(r.summary.reconciliation_status, "not_reconciled_with_finance");
});

test("aggregate unpaid is rejected rather than silently excluding open invoice statuses", () => {
  assert.throws(() => createSnapshot({ ...spec, statuses: ["unpaid"] }, orgs), /receivables_report/);
});

import Decimal from "decimal.js";
import { createHash, randomUUID } from "node:crypto";
import { VERSION, BUILD_ID, integerSetting } from "./security.js";

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
export function money(value) {
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^-?\d{1,30}(?:\.\d{1,12})?$/.test(String(value))) throw new Error("Missing, invalid or unsupported-precision decimal amount");
  if (typeof value === "number" && Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error("Send large monetary values as decimal strings");
  const result = new Decimal(value);
  if (!result.isFinite()) throw new Error("Invalid amount");
  return result;
}
export function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validateRange(start, end) {
  if (!validDate(start) || !validDate(end) || start > end) throw new Error("Use a valid inclusive date_start/date_end range (YYYY-MM-DD)");
}
const currencies = new Set(Intl.supportedValuesOf("currency"));
export function currency(value) { return currencies.has(value) ? value : null; }
function formatted(value, code) {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  return { exact: value.toFixed(), formatted: value.toFixed(digits) };
}
export function fingerprint(value) {
  function ordered(v) {
    if (Array.isArray(v)) return v.map(ordered);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k])]));
    return v;
  }
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}
export function extractRows(data, key) {
  if (!data || !Array.isArray(data[key]) || data[key].some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error(`Invalid response: expected ${key} records`);
  }
  return data[key];
}
export function agingBucket(row, asOf) {
  if (!validDate(asOf)) throw new Error("An aging report requires a valid as_of date");
  let balance;
  try { balance = money(row.balance); } catch { return "unknown balance"; }
  if (balance.lte(0)) return "settled (no positive balance)";
  if (!validDate(row.due_date)) return "unknown due date";
  const days = (Date.parse(asOf) - Date.parse(row.due_date)) / 86400000;
  return days <= 0 ? "current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
}

// Exact source fields, not accounting interpretations such as recognized revenue.
export const METRICS = {
  contacts: ["outstanding_receivable_amount"],
  customer_payments: ["amount"], vendor_payments: ["amount"], expenses: ["amount"],
  invoices: ["total", "balance"], bills: ["total", "balance"], credit_notes: ["total", "balance"],
  vendor_credits: ["total", "balance"], estimates: ["total"], sales_orders: ["total"], purchase_orders: ["total"],
};
const STATUS_FILTERS = {
  invoices: ["draft", "sent", "viewed", "overdue", "partially_paid", "paid", "void", "unpaid"],
  bills: ["draft", "open", "overdue", "partially_paid", "paid", "void"],
  estimates: ["draft", "sent", "viewed", "accepted", "declined", "expired", "invoiced"],
};
export function validateSpec(spec) {
  if (spec.date_start || spec.date_end) validateRange(spec.date_start, spec.date_end);
  if (spec.metric !== "count" && !METRICS[spec.module]?.includes(spec.metric)) throw new Error("This module/metric has no validated calculation; use record count or inspect individual records");
  if (spec.statuses?.some(status => !STATUS_FILTERS[spec.module]?.includes(status))) throw new Error("Unsupported status filter for this module; use documented exact statuses or inspect source records");
  if (spec.module === "invoices" && spec.statuses?.includes("unpaid")) throw new Error("unpaid is an aggregate API filter, not a reliable returned invoice status. Use receivables_report for current customer balances or explicit sent/viewed/overdue/partially_paid status filters.");
  if (spec.kind === "collections" && (spec.module !== "customer_payments" || spec.metric !== "amount" || !spec.date_start || !spec.date_end)) throw new Error("Collections require customer payments and a payment-date range");
  if (spec.metric === "outstanding_receivable_amount" && (spec.kind !== "receivables" || spec.module !== "contacts" || spec.group_by !== "customer" || spec.date_start || spec.date_end || spec.as_of || spec.statuses || spec.search_text || spec.vendor_id)) throw new Error("Use receivables_report for current customer balances; historical dates and invoice filters do not apply");
  if (spec.kind === "receivables" && spec.metric !== "outstanding_receivable_amount") throw new Error("Receivables require Zoho's customer outstanding balance field");
  if (spec.as_of && !validDate(spec.as_of)) throw new Error("Invalid as_of date");
  if (spec.as_of && spec.metric !== "balance") throw new Error("as_of is supported only for current balance reports");
  if (spec.group_by === "aging" && (!["invoices", "bills"].includes(spec.module) || spec.metric !== "balance" || !spec.as_of)) throw new Error("Aging requires invoices/bills, metric balance, and an explicit current as_of date");
  if (spec.metric === "balance" && spec.as_of && spec.as_of !== new Date().toISOString().slice(0, 10)) throw new Error("Historical balances are not reconstructed by this report. Use a historical Zoho report for that cutoff.");
  if (["customer", "vendor"].includes(spec.group_by) && !["contacts", ...Object.keys(METRICS)].includes(spec.module)) throw new Error("This module does not have a validated party grouping");
}
export function selectOrganizations(available, { organization_id, organization_ids, all_organizations }) {
  if (organization_ids && !organization_ids.length) throw new Error("organization_ids must not be empty");
  if ([Boolean(organization_id), Boolean(organization_ids), Boolean(all_organizations)].filter(Boolean).length !== 1) throw new Error("Select exactly one scope: organization_id, organization_ids, or all_organizations");
  const ids = organization_ids || (organization_id ? [organization_id] : null);
  if (!available.length) throw new Error("No accessible organizations");
  if (ids) {
    const missing = ids.filter(id => !available.some(o => String(o.organization_id) === id));
    if (missing.length) throw new Error(`Requested organizations are not accessible: ${missing.join(", ")}`);
  }
  return available.filter(o => !ids || ids.includes(String(o.organization_id)));
}

const VERIFICATION_METHOD = "record-fields-v1";
const SEARCH_FIELDS = ["contact_name", "customer_name", "vendor_name", "name", "reference_number", "invoice_number", "bill_number", "description"];
const baseField = spec => spec.metric === "outstanding_receivable_amount" ? "outstanding_receivable_amount_bcy" : "bcy_" + spec.metric;

// Only fields used in the financial calculation, selection, or grouping are compared.
// Original source records remain available as retrieval evidence, not as verified metadata.
export function verificationFields(row, spec, module) {
  const fields = new Set([module.idField]);
  if (spec.metric !== "count") [spec.metric, baseField(spec), "currency_code"].forEach(f => fields.add(f));
  if (spec.date_start || spec.group_by === "month") ["date", "journal_date"].forEach(f => fields.add(f));
  if (spec.statuses?.length || spec.group_by === "status") fields.add("status");
  if (spec.group_by === "currency") fields.add("currency_code");
  if (spec.group_by === "aging") ["balance", "due_date"].forEach(f => fields.add(f));
  for (const party of ["customer", "vendor"]) {
    if (spec[party + "_id"] || spec.group_by === party) [party + "_id", "contact_id"].forEach(f => fields.add(f));
    if (spec.group_by === party) [party + "_name", "contact_name"].forEach(f => fields.add(f));
  }
  if (spec.kind === "receivables") fields.add("contact_type");
  if (spec.search_text) SEARCH_FIELDS.forEach(f => fields.add(f));
  const monetary = new Set([spec.metric, baseField(spec), ...(spec.group_by === "aging" ? ["balance"] : [])]);
  return Object.fromEntries([...fields].map(field => {
    const value = row[field] ?? null;
    if (monetary.has(field) && value !== null) {
      try { return [field, money(value).toFixed()]; } catch { /* calculate() rejects invalid money */ }
    }
    return [field, value];
  }));
}

function resetOrganization(org) {
  Object.assign(org, { page: 1, rows: [], done: false, verified: false, blocked: false,
    verification_page: 1, verification_ids: [], changed_records: 0, added_records: 0,
    difference_samples: [], errors: [], pending_page: null, attempt_started_at: new Date().toISOString(), verified_at: null });
}
export function createSnapshot(spec, orgs) {
  validateSpec(spec);
  const organizations = orgs.map(o => {
    const org = { id: String(o.organization_id), name: o.name, currency: currency(o.currency_code), retry_count: 0, verification_failures: [] };
    resetOrganization(org);
    return org;
  });
  return { id: randomUUID(), version: VERSION, build_id: BUILD_ID, verification_method: VERIFICATION_METHOD,
    spec, started_at: new Date().toISOString(), organizations, finished_at: null };
}
function pagination(data, page, rows) {
  let context = data.page_context;
  // Zoho documents both an object and a single-element array for invoice metadata.
  if (Array.isArray(context)) {
    if (context.length !== 1 || !context[0]) throw new Error("Invalid pagination metadata");
    [context] = context;
  }
  if (context != null && (typeof context !== "object" || Array.isArray(context))) throw new Error("Invalid pagination metadata");
  for (const field of ["page", "per_page"]) {
    if (context?.[field] !== undefined && (!/^\d+$/.test(String(context[field])) || !Number.isSafeInteger(Number(context[field])) || Number(context[field]) < 1)) throw new Error("Invalid pagination metadata");
  }
  if (context?.page !== undefined && Number(context.page) !== page) throw new Error("Pagination returned a different page than requested");
  const more = context?.has_more_page;
  if (more !== undefined && typeof more !== "boolean") throw new Error("Invalid pagination metadata");
  if (more === true && !rows.length) throw new Error("Empty page claims more records; completion is unknown");
  return more === false || (more === undefined && rows.length === 0);
}
function sourceFailure(org, detail) {
  org.verification_failures.push({ attempt: org.retry_count + 1, phase: org.done ? "verification" : "retrieval",
    page: org.done ? org.verification_page : org.page, observed_at: new Date().toISOString(), ...detail });
  if (org.retry_count < 1) { org.retry_count++; resetOrganization(org); return; }
  org.errors.push(detail.code === "duplicate_ids" ? "Missing or duplicate record IDs after one retry; inspect verification_failures" : "Report-relevant source records changed after one retry; inspect verification_failures and start a new report");
  org.blocked = true;
}

// Both complete passes use the same query and compare ID sets, not page boundaries.
// Pending detail reads, seen IDs and diagnostics survive encrypted continuations.
export async function advanceSnapshot(snapshot, module, read, budget = 10) {
  const maxRows = integerSetting("MAX_REPORT_RECORDS", 100000, 200, 1000000);
  if (snapshot.verification_method !== VERIFICATION_METHOD) {
    snapshot.verification_method = VERIFICATION_METHOD;
    snapshot.restart_reason = "Upgraded verification; both passes restarted using the original report scope";
    snapshot.version = VERSION; snapshot.build_id = BUILD_ID; snapshot.started_at = new Date().toISOString();
    delete snapshot.reconciliation; delete snapshot.reconciliation_differences;
    for (const org of snapshot.organizations) {
      org.retry_count = 0; org.verification_failures = []; delete org.page_fingerprints; resetOrganization(org);
    }
  }
  const request = async query => {
    budget--;
    try { return await read(query); } catch { return { ok: false, text: "Read failed" }; }
  };
  for (const org of snapshot.organizations) {
    if (org.verified || org.blocked) continue;
    org.errors = [];
    let originals = new Map(org.rows.map(row => [row[module.idField], row]));
    let seen = new Set(org.verification_ids);
    const failSource = detail => { sourceFailure(org, detail); originals = new Map(org.rows.map(row => [row[module.idField], row])); seen = new Set(org.verification_ids); };
    while (!org.verified && !org.blocked && (budget > 0 || org.pending_page)) {
      const requestedPage = org.done ? org.verification_page : org.page;
      if (!org.pending_page) {
        const query = { organization_id: org.id, page: requestedPage, per_page: 200,
          ...(["invoices", "contacts"].includes(snapshot.spec.module) && { sort_column: "created_time", sort_order: "A" }),
          ...(snapshot.spec.kind === "receivables" && { contact_type: "customer", filter_by: "Status.All" }) };
        const r = await request({ method: "GET", path: module.path, query });
        if (!r.ok) { org.errors.push(r.text); break; }
        let rows, terminal;
        try { rows = extractRows(r.data, module.rowKey); terminal = pagination(r.data, requestedPage, rows); }
        catch (error) { org.errors.push(error.message); org.blocked = true; break; }
        const pageIds = new Set(); const prior = org.done ? seen : originals;
        const invalid = rows.find(row => typeof row[module.idField] !== "string" || !row[module.idField] || prior.has(row[module.idField]) ||
          (pageIds.has(row[module.idField]) ? true : (pageIds.add(row[module.idField]), false)));
        if (invalid) { failSource({ code: "duplicate_ids", record_id: invalid[module.idField] ?? null }); continue; }
        const storedCount = snapshot.organizations.reduce((n, o) => n + o.rows.length, 0);
        if ((!org.done && storedCount + rows.length > maxRows) || (org.done && seen.size + rows.length > maxRows)) {
          org.errors.push("Report storage limit reached; use a smaller source scope or a native Zoho export"); org.blocked = true; break;
        }
        org.pending_page = { rows, terminal, detail_index: 0 };
      }
      const pending = org.pending_page;
      // The list can omit a foreign customer's recorded base balance. Read the
      // documented contact detail instead of converting with an assumed rate.
      while (pending.detail_index < pending.rows.length) {
        const row = pending.rows[pending.detail_index];
        if (snapshot.spec.kind === "receivables" && (snapshot.spec.currency_basis === "base"
          ? row[baseField(snapshot.spec)] == null && (currency(row.currency_code) !== org.currency || row.outstanding_receivable_amount == null)
          : row.outstanding_receivable_amount == null || !currency(row.currency_code))) {
          if (budget <= 0) break;
          const r = await request({ method: "GET", path: module.path + "/" + encodeURIComponent(row[module.idField]), query: { organization_id: org.id } });
          if (!r.ok) { org.errors.push(r.text); break; }
          const detail = r.data?.contact;
          if (!detail || detail.contact_id !== row.contact_id) { org.errors.push("Contact detail identity does not match the requested customer"); org.blocked = true; break; }
          for (const field of ["outstanding_receivable_amount", "outstanding_receivable_amount_bcy", "currency_code", "contact_name", "contact_type"]) row[field] = detail[field];
        }
        pending.detail_index++;
      }
      if (org.blocked || org.errors.length || pending.detail_index < pending.rows.length) break;
      if (!org.done) {
        org.rows.push(...pending.rows);
        for (const row of pending.rows) originals.set(row[module.idField], row);
        org.page++; org.done = pending.terminal;
      } else {
        for (const row of pending.rows) {
          const id = row[module.idField]; seen.add(id); org.verification_ids.push(id);
          const original = originals.get(id);
          if (!original) { org.added_records++; if (org.difference_samples.length < 20) org.difference_samples.push({ record_id: id, reason: "added" }); continue; }
          const before = verificationFields(original, snapshot.spec, module), after = verificationFields(row, snapshot.spec, module);
          const fields = Object.keys(before).filter(key => fingerprint(before[key]) !== fingerprint(after[key]));
          if (fields.length) { org.changed_records++; if (org.difference_samples.length < 20) org.difference_samples.push({ record_id: id, reason: "changed", fields }); }
        }
        if (pending.terminal) {
          const missing = [...originals.keys()].filter(id => !seen.has(id));
          if (missing.length || org.added_records || org.changed_records) {
            failSource({ code: "source_records_changed", added_records: org.added_records, missing_records: missing.length, changed_records: org.changed_records,
              samples: [...org.difference_samples, ...missing.slice(0, 20).map(record_id => ({ record_id, reason: "missing" }))].slice(0, 20) });
            continue;
          }
          org.verified = true; org.verified_at = new Date().toISOString();
        }
        org.verification_page++;
      }
      org.pending_page = null;
    }
  }
  snapshot.finished_at = snapshot.organizations.every(o => o.verified) ? snapshot.finished_at || new Date().toISOString() : null;
  return snapshot;
}

function groupFor(row, spec, resolvedCurrency) {
  const mode = spec.group_by;
  if (!mode) return null;
  if (mode === "aging") return { id: agingBucket(row, spec.as_of), name: agingBucket(row, spec.as_of) };
  if (mode === "customer" || mode === "vendor") {
    const id = row[mode + "_id"] || row.contact_id;
    if (!id) throw new Error(`Missing ${mode} identity for grouping`);
    return { id: String(id), name: row[mode + "_name"] || row.contact_name || String(id) };
  }
  if (mode === "month") {
    const date = row.date || row.journal_date;
    if (!validDate(date)) throw new Error("Missing date for monthly grouping");
    return { id: date.slice(0, 7), name: date.slice(0, 7) };
  }
  const key = mode === "currency" ? resolvedCurrency || currency(row.currency_code) : row.status;
  if (!key) throw new Error(`Missing ${mode} for grouping`);
  return { id: key, name: key };
}

export function calculate(snapshot, module) {
  const { spec } = snapshot;
  const evidence = []; const errors = []; const excluded = []; const totals = new Map(); const groups = new Map();
  let count = 0;
  const sum = (map, key, info, amount) => {
    const bucket = map.get(key) || { ...info, count: 0, sum: new Decimal(0) };
    bucket.count++; if (amount) bucket.sum = bucket.sum.plus(amount);
    map.set(key, bucket);
  };
  for (const org of snapshot.organizations) {
    for (const row of org.rows) {
      const id = String(row[module.idField]);
      const date = row.date || row.journal_date;
      let reason;
      if (spec.kind === "receivables") {
        if (!["customer", "vendor"].includes(row.contact_type)) { errors.push({ organization_id: org.id, record_id: id, error: "Missing/unsupported contact type" }); continue; }
        if (row.contact_type !== "customer") reason = "not a customer";
      }
      if (spec.date_start) {
        if (!validDate(date)) { errors.push({ organization_id: org.id, record_id: id, error: "Missing/invalid date" }); continue; }
        if (date < spec.date_start || date > spec.date_end) reason = "outside requested dates";
      }
      if (spec.statuses?.length) {
        if (!row.status) { errors.push({ organization_id: org.id, record_id: id, error: "Missing status" }); continue; }
        if (!spec.statuses.includes(row.status)) reason = "excluded status";
      }
      if ((spec.customer_id && !row.customer_id && !row.contact_id) || (spec.vendor_id && !row.vendor_id && !row.contact_id)) {
        errors.push({ organization_id: org.id, record_id: id, error: "Missing party ID needed to verify the filter" }); continue;
      }
      if (spec.customer_id && String(row.customer_id || row.contact_id) !== spec.customer_id) reason = "different customer";
      if (spec.vendor_id && String(row.vendor_id || row.contact_id) !== spec.vendor_id) reason = "different vendor";
      if (spec.search_text) {
        const fields = SEARCH_FIELDS;
        if (!fields.some(field => typeof row[field] === "string")) { errors.push({ organization_id: org.id, record_id: id, error: "Missing fields needed to verify text filter" }); continue; }
        if (!fields.some(field => typeof row[field] === "string" && row[field].toLowerCase().includes(spec.search_text.toLowerCase()))) reason = "text filter did not match";
      }
      if (reason) { excluded.push({ organization_id: org.id, record_id: id, reason }); continue; }
      count++;
      const audit = { organization_id: org.id, organization_name: org.name, record_id: id, date,
        customer_id: row.customer_id || (spec.kind === "receivables" ? row.contact_id : undefined), customer_name: row.customer_name || (spec.kind === "receivables" ? row.contact_name : undefined), status: row.status,
        transaction_currency: currency(row.currency_code), original_amount: row[spec.metric],
        recorded_base_amount: row[baseField(spec)], base_currency: org.currency };
      try {
        let amount = null; let code = null; let source = "record count";
        if (spec.metric !== "count") {
          if (spec.currency_basis === "base") {
            code = org.currency;
            if (!code) throw new Error("Organization base currency is unknown");
            const base = row[baseField(spec)];
            if (base !== undefined && base !== null) { amount = money(base); source = baseField(spec); }
            else if (currency(row.currency_code) === code) { amount = money(row[spec.metric]); source = spec.metric + " (same currency)"; }
            else throw new Error("Recorded base amount missing; no exchange rate is assumed");
          } else {
            code = currency(row.currency_code);
            if (!code) throw new Error("Transaction currency missing; organization currency is not a substitute");
            amount = money(row[spec.metric]); source = spec.metric;
          }
        }
        Object.assign(audit, { included_amount: amount?.toFixed() ?? null, included_currency: code, amount_source: source });
        sum(totals, JSON.stringify([org.id, code]), { organization_id: org.id, currency: code }, amount);
        if (spec.group_by) {
          const group = groupFor(row, spec, code);
          if (spec.group_by === "aging" && group.id.startsWith("unknown")) throw new Error(group.id);
          sum(groups, JSON.stringify([org.id, group.id, code]), { organization_id: org.id, group_id: group.id, group_name: group.name, currency: code }, amount);
        }
      } catch (error) { audit.error = error.message; errors.push({ organization_id: org.id, record_id: id, error: error.message }); }
      evidence.push(audit);
    }
  }
  const retrievalComplete = snapshot.organizations.every(o => o.done && o.verified && !o.errors.length);
  const complete = retrievalComplete && !errors.length;
  const present = map => [...map.values()].map(({ sum, ...bucket }) => ({ ...bucket,
    ...(spec.metric !== "count" && { amount: formatted(sum, bucket.currency) }) }));
  const rankedGroups = complete ? present(groups) : [];
  if (spec.kind === "receivables") {
    rankedGroups.sort((a, b) => a.organization_id.localeCompare(b.organization_id) || a.currency.localeCompare(b.currency) || money(b.amount.exact).cmp(money(a.amount.exact)) || a.group_id.localeCompare(b.group_id));
    let scope, rank = 0;
    for (const group of rankedGroups) { const key = JSON.stringify([group.organization_id, group.currency]); if (key !== scope) { scope = key; rank = 0; } group.rank_in_organization_currency = ++rank; }
  }
  return {
    summary: { report_id: snapshot.id, version: snapshot.version, build_id: snapshot.build_id, specification: spec,
      started_at: snapshot.started_at, finished_at: snapshot.finished_at,
      organizations: snapshot.organizations.map(o => ({ organization_id: o.id, name: o.name, base_currency: o.currency,
        fetched_records: o.rows.length, pages: o.page - 1, retrieval_complete: o.done, second_pass_verified: o.verified, errors: o.errors,
        verification_pages: o.verification_page - 1, retry_count: o.retry_count || 0, attempt_started_at: o.attempt_started_at,
        verified_at: o.verified_at, verification_failures: o.verification_failures || [],
        ...(o.pending_page && { pending_page_records: o.pending_page.rows.length, pending_details_processed: o.pending_page.detail_index }) })),
      retrieval_complete: retrievalComplete, values_valid: !errors.length, figures_are_complete: complete,
      reconciliation_status: snapshot.reconciliation?.status || "not_reconciled_with_finance",
      ...(snapshot.reconciliation && { reconciliation: snapshot.reconciliation }),
      verification_method: snapshot.verification_method || "legacy-page-fingerprint",
      ...(snapshot.restart_reason && { restart_reason: snapshot.restart_reason }),
      source_consistency: snapshot.verification_method === VERIFICATION_METHOD ? "Two complete reads; unique ID sets and normalized report fields compared independent of order/page boundaries. One automatic retry on source changes. No transactional snapshot guarantee." : "Legacy page fingerprints; continue_report restarts both passes with record-field verification.",
      evidence_scope: "Original retrieved records; verification covers report calculation, selection and grouping fields, not unrelated source metadata",
      consolidation: "Separate organization totals; no intercompany eliminations",
      record_count: complete ? count : null, observed_matching_records: count, excluded_count: excluded.length,
      totals: complete ? present(totals) : null,
      validation_error_count: errors.length,
      evidence_count: evidence.length, group_count: groups.size,
      continuation_available: snapshot.organizations.some(o => !o.verified && !o.blocked),
      definition: spec.kind === "collections" ? "Gross recorded customer-payment receipts by payment date. Refunds, fees, withholding and invoice allocations are not netted. Uses recorded base amounts when requested." :
        spec.kind === "receivables" ? "Current customer outstanding balances reported by Zoho Contacts, including inactive customers. Unused credits are not independently subtracted. Not a historical closing balance or an invoice-only total. Ranking is separate for each organization and currency." :
        `Source-field ${spec.metric} report. Not recognized revenue, consolidated accounts, net cash flow, or reconstructed historical balances.`,
      ...(spec.metric === "balance" && { balance_basis: "Current source balances at retrieval; date filters select invoice/bill dates, not historical settlement cutoffs", aging_calendar: "Explicit as_of date, restricted to today's UTC date" }),
    }, evidence, exclusions: excluded, validation_errors: errors, groups: rankedGroups,
  };
}

export function reconcileEvidence(evidence, references) {
  const key = row => JSON.stringify([row.organization_id, row.record_id]);
  const expected = new Map(); const differences = [];
  for (const ref of references) {
    if (expected.has(key(ref))) throw new Error("Duplicate reference record ID within an organization");
    money(ref.amount);
    if (!currency(ref.currency)) throw new Error("Invalid reference currency");
    expected.set(key(ref), ref);
  }
  for (const row of evidence) {
    const ref = expected.get(key(row));
    if (!ref) differences.push({ organization_id: row.organization_id, record_id: row.record_id, reason: "Not present in supplied reference" });
    else {
      if (row.error || row.included_currency !== ref.currency || row.included_amount === null || !money(row.included_amount).eq(money(ref.amount))) {
        differences.push({ organization_id: row.organization_id, record_id: row.record_id, reason: "Amount or currency differs", actual: row.included_amount, actual_currency: row.included_currency, expected: ref.amount, expected_currency: ref.currency });
      }
      expected.delete(key(row));
    }
  }
  for (const ref of expected.values()) differences.push({ organization_id: ref.organization_id, record_id: ref.record_id, reason: "Missing from report" });
  return { status: differences.length ? "differs_from_supplied_reference" : "matches_supplied_reference", differences, reference_count: references.length };
}

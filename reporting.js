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
  if (spec.kind === "collections" && (spec.module !== "customer_payments" || spec.metric !== "amount" || !spec.date_start || !spec.date_end)) throw new Error("Collections require customer payments and a payment-date range");
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

export function createSnapshot(spec, orgs) {
  validateSpec(spec);
  return { id: randomUUID(), version: VERSION, build_id: BUILD_ID, spec, started_at: new Date().toISOString(),
    organizations: orgs.map(o => ({ id: String(o.organization_id), name: o.name, currency: currency(o.currency_code), page: 1,
      rows: [], done: false, verified: false, verification_page: 1, errors: [], page_fingerprints: [] })), finished_at: null };
}

// A bounded amount of work per call. The encrypted snapshot preserves continuation.
export async function advanceSnapshot(snapshot, module, read, budget = 10) {
  const maxRows = integerSetting("MAX_REPORT_RECORDS", 100000, 200, 1000000);
  for (const org of snapshot.organizations) {
    if (org.verified || org.blocked) continue;
    org.errors = []; // Transient read errors can be retried via continue_report.
    while (!org.verified && budget > 0) {
      budget--;
      let r;
      const requestedPage = org.done ? org.verification_page : org.page;
      try { r = await read({ method: "GET", path: module.path, query: { organization_id: org.id, page: requestedPage, per_page: 200 } }); }
      catch { r = { ok: false, text: "Read failed" }; }
      if (!r.ok) { org.errors.push(r.text); break; }
      let rows;
      try { rows = extractRows(r.data, module.rowKey); }
      catch (error) { org.errors.push(error.message); org.blocked = true; break; }
      if (org.done) {
        if (fingerprint({ rows, more: r.data.page_context?.has_more_page ?? null }) !== org.page_fingerprints[requestedPage - 1]) {
          org.errors.push("Source changed between retrieval and verification; start a new report"); org.blocked = true; break;
        }
        org.verification_page++;
        org.verified = org.verification_page > org.page_fingerprints.length;
        continue;
      }
      const priorIds = new Set(org.rows.map(row => String(row[module.idField])));
      const pageIds = new Set();
      if (rows.some(row => typeof row[module.idField] !== "string" || !row[module.idField] || priorIds.has(String(row[module.idField])) ||
          (pageIds.has(String(row[module.idField])) ? true : (pageIds.add(String(row[module.idField])), false)))) {
        org.errors.push("Missing or duplicate record IDs; source changed or a page repeated"); org.blocked = true; break;
      }
      if (snapshot.organizations.reduce((n, o) => n + o.rows.length, 0) + rows.length > maxRows) {
        org.errors.push("Report storage limit reached; use a smaller source scope or a native Zoho export"); org.blocked = true; break;
      }
      const more = r.data.page_context?.has_more_page;
      if (more !== undefined && typeof more !== "boolean") {
        org.errors.push("Invalid pagination metadata"); org.blocked = true; break;
      }
      if (more === true && !rows.length) {
        org.errors.push("Empty page claims more records; completion is unknown"); org.blocked = true; break;
      }
      org.rows.push(...rows);
      org.page_fingerprints.push(fingerprint({ rows, more: more ?? null }));
      org.page++;
      // With absent metadata, request the next page even if this page is short.
      // Only an explicit false or a subsequent empty page ends retrieval.
      org.done = more === false || (more === undefined && rows.length === 0);
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
        const fields = ["contact_name", "customer_name", "vendor_name", "name", "reference_number", "invoice_number", "bill_number", "description"];
        if (!fields.some(field => typeof row[field] === "string")) { errors.push({ organization_id: org.id, record_id: id, error: "Missing fields needed to verify text filter" }); continue; }
        if (!fields.some(field => typeof row[field] === "string" && row[field].toLowerCase().includes(spec.search_text.toLowerCase()))) reason = "text filter did not match";
      }
      if (reason) { excluded.push({ organization_id: org.id, record_id: id, reason }); continue; }
      count++;
      const audit = { organization_id: org.id, organization_name: org.name, record_id: id, date,
        customer_id: row.customer_id, customer_name: row.customer_name, status: row.status,
        transaction_currency: currency(row.currency_code), original_amount: row[spec.metric],
        recorded_base_amount: row["bcy_" + spec.metric], base_currency: org.currency };
      try {
        let amount = null; let code = null; let source = "record count";
        if (spec.metric !== "count") {
          if (spec.currency_basis === "base") {
            code = org.currency;
            if (!code) throw new Error("Organization base currency is unknown");
            const base = row["bcy_" + spec.metric];
            if (base !== undefined && base !== null) { amount = money(base); source = "bcy_" + spec.metric; }
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
  return {
    summary: { report_id: snapshot.id, version: snapshot.version, build_id: snapshot.build_id, specification: spec,
      started_at: snapshot.started_at, finished_at: snapshot.finished_at,
      organizations: snapshot.organizations.map(o => ({ organization_id: o.id, name: o.name, base_currency: o.currency,
        fetched_records: o.rows.length, pages: o.page - 1, retrieval_complete: o.done, second_pass_verified: o.verified, errors: o.errors })),
      retrieval_complete: retrievalComplete, values_valid: !errors.length, figures_are_complete: complete,
      reconciliation_status: snapshot.reconciliation?.status || "not_reconciled_with_finance",
      ...(snapshot.reconciliation && { reconciliation: snapshot.reconciliation }),
      source_consistency: "Every page re-read and fingerprint compared before completion; no transactional snapshot guarantee",
      consolidation: "Separate organization totals; no intercompany eliminations",
      record_count: complete ? count : null, observed_matching_records: count, excluded_count: excluded.length,
      totals: complete ? present(totals) : null,
      validation_error_count: errors.length,
      evidence_count: evidence.length, group_count: groups.size,
      continuation_available: snapshot.organizations.some(o => !o.verified && !o.blocked),
      definition: spec.kind === "collections" ? "Gross recorded customer-payment receipts by payment date. Refunds, fees, withholding and invoice allocations are not netted. Uses recorded base amounts when requested." :
        `Source-field ${spec.metric} report. Not recognized revenue, consolidated accounts, net cash flow, or reconstructed historical balances.`,
      ...(spec.metric === "balance" && { balance_basis: "Current source balances at retrieval; date filters select invoice/bill dates, not historical settlement cutoffs", aging_calendar: "Explicit as_of date, restricted to today's UTC date" }),
    }, evidence, exclusions: excluded, validation_errors: errors, groups: complete ? present(groups) : [],
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

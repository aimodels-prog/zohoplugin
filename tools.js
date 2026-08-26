// The 60 Zoho Books tools, generated from a declarative entity table.
//
// Every tool's run() takes the calling user's id. That id resolves to their own Zoho
// refresh token and default organization inside zoho.js, so the same tool definitions
// serve every connected account without any of them seeing each other's data.

import { z } from "zod";
import { zohoRequest } from "./zoho.js";
import * as db from "./db.js";

const PREFIX = "ZohoBooks_";
const READ_ONLY = String(process.env.ZOHO_READ_ONLY || "").toLowerCase() === "true";

// ---------------------------------------------------------------------------
// Shared argument shapes
// ---------------------------------------------------------------------------

const orgArg = {
  organization_id: z
    .string()
    .optional()
    .describe("Zoho Books organization ID. Omit to use your default organization."),
};

const listArgs = {
  ...orgArg,
  page: z.coerce.number().int().min(1).optional().describe("Page number, starting at 1."),
  per_page: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Records per page (Zoho maximum is 200)."),
  sort_column: z.string().optional().describe("Field to sort by, e.g. 'date' or 'total'."),
  sort_order: z.enum(["A", "D"]).optional().describe("A = ascending, D = descending."),
  search_text: z.string().optional().describe("Free-text search across the record's main fields."),
  filter_by: z
    .string()
    .optional()
    .describe("Zoho status filter, e.g. 'Status.All', 'Status.Sent', 'Status.Overdue', 'Status.Draft'."),
  params: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      'Any additional Zoho query parameters as key/value pairs, e.g. {"customer_id":"460000000012345","date_start":"2026-01-01","date_end":"2026-03-31"}.'
    ),
  all_organizations: z
    .boolean()
    .optional()
    .describe(
      "Set true to query EVERY organization this user can access and merge the results into one " +
        "answer. Use whenever the question is about the business as a whole rather than one " +
        "country or entity — e.g. 'all our invoices', 'total across the group', 'company-wide'. " +
        "Each returned record is tagged with _organization_name and _currency_code. " +
        "Organizations may use different currencies: never add amounts across them without " +
        "converting, and report per-organization subtotals instead."
    ),
  organization_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Query this specific set of organizations and merge the results, e.g. the Oman and Saudi " +
        "entities only. Takes precedence over all_organizations."
    ),
  summarize: z
    .boolean()
    .optional()
    .describe(
      "Set true for totals, counts and sums instead of individual records. USE THIS FOR ANY " +
        "'how much', 'total', 'revenue', 'outstanding' or 'how many' question. The server reads " +
        "every page internally and returns complete aggregates — amounts summed per currency, " +
        "counts per status, per organization — in a small response. Listing raw records for " +
        "such questions overflows the response limit and yields incomplete figures."
    ),
  group_by: z
    .enum(["customer", "vendor", "month", "status", "currency", "aging"])
    .optional()
    .describe(
      "Break the summary down by this dimension (implies summarize). Complete and exact, " +
        "however many records exist. Use 'customer' for top clients or revenue per customer, " +
        "'vendor' for spend per supplier, 'month' for monthly or quarterly trends, 'status' for " +
        "paid vs overdue, and 'aging' for a receivables/payables ageing report bucketed by how " +
        "overdue each balance is (current, 1-30, 31-60, 61-90, 90+ days). " +
        "'aging' only makes sense on invoices and bills."
    ),
};

const dataArg = (hint) => ({
  data: z.record(z.string(), z.any()).describe(`The record body as a JSON object. ${hint}`),
});

/**
 * Strips fields that are ours rather than Zoho's; organization_id passes through and
 * zoho.js fills in the default. all_organizations / organization_ids drive the fan-out
 * below and must never reach Zoho as query parameters.
 */
function buildQuery(args) {
  const { params, data, all_organizations, organization_ids, summarize, group_by, ...rest } = args || {};
  const query = { ...(params || {}), ...rest };
  for (const k of Object.keys(query)) if (query[k] === undefined) delete query[k];
  return query;
}

function result(r) {
  return { content: [{ type: "text", text: r.text }], isError: !r.ok };
}

const seg = (v) => encodeURIComponent(String(v));

const MAX_CHARS = Number(process.env.MAX_RESPONSE_CHARS || 60000);

/** Zoho wraps rows under a single array key: {invoices:[…]}, {contacts:[…]}, … */
function extractRows(data) {
  if (!data || typeof data !== "object") return null;
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) return { key: k, rows: v };
  }
  return null;
}

// Monetary fields Zoho uses across entities; only those actually present get summed.
const SUM_FIELDS = ["total", "balance", "amount", "sub_total", "outstanding_receivable_amount"];
const MAX_PAGES = 30; // 30 × 200 = 6000 records per organization

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Reads every page for one organization. Aggregate answers must be complete — a partial
 * total is worse than no total — so this follows page_context.has_more_page to the end.
 */
async function fetchAllPages(userId, { path, query, orgId }) {
  const rows = [];
  let page = 1;
  let pages = 0;
  let complete = true;

  while (true) {
    const r = await zohoRequest(userId, {
      method: "GET",
      path,
      query: { ...query, organization_id: orgId, page, per_page: 200 },
    });
    if (!r.ok) return { error: r.text, rows, pages, complete: false };

    const got = extractRows(r.data)?.rows ?? [];
    rows.push(...got);
    pages++;

    if (!r.data?.page_context?.has_more_page || !got.length) break;
    if (pages >= MAX_PAGES) {
      complete = false;
      break;
    }
    page++;
  }
  return { rows, pages, complete };
}

const DAY = 86400000;
const AGING_ORDER = [
  "current (not yet due)",
  "1-30 days overdue",
  "31-60 days overdue",
  "61-90 days overdue",
  "90+ days overdue",
  "settled (no balance)",
  "(no due date)",
];

/** Standard receivables/payables ageing bucket, from due date against today. */
function agingBucket(row) {
  if ((num(row.balance) ?? 0) <= 0) return "settled (no balance)";
  const due = row.due_date || row.date;
  if (!due) return "(no due date)";
  const days = Math.floor((Date.now() - Date.parse(due)) / DAY);
  if (!Number.isFinite(days)) return "(no due date)";
  if (days <= 0) return "current (not yet due)";
  if (days <= 30) return "1-30 days overdue";
  if (days <= 60) return "31-60 days overdue";
  if (days <= 90) return "61-90 days overdue";
  return "90+ days overdue";
}

function groupKeyFor(row, mode, fallbackCurrency) {
  switch (mode) {
    case "customer":
      return row.customer_name || row.contact_name || "(unnamed customer)";
    case "vendor":
      return row.vendor_name || row.contact_name || "(unnamed vendor)";
    case "status":
      return row.status || "(no status)";
    case "currency":
      return row.currency_code || fallbackCurrency || "unknown";
    case "month":
      return String(row.date || row.journal_date || row.created_time || "").slice(0, 7) || "(no date)";
    case "aging":
      return agingBucket(row);
    default:
      return "all";
  }
}

const MAX_GROUPS = 300;

/**
 * Counts and sums one organization's rows, keeping currencies separate and optionally
 * breaking the figures down by customer, vendor, month, status or ageing bucket.
 */
function aggregate(rows, fallbackCurrency, groupBy) {
  const byCurrency = {};
  const byStatus = {};
  const groups = new Map();

  for (const row of rows) {
    const cur = row.currency_code || fallbackCurrency || "unknown";
    const bucket = (byCurrency[cur] ??= { count: 0 });
    bucket.count++;
    for (const f of SUM_FIELDS) {
      const n = num(row[f]);
      if (n !== null) bucket[f] = round2((bucket[f] ?? 0) + n);
    }
    if (row.status) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

    if (groupBy) {
      const key = `${groupKeyFor(row, groupBy, fallbackCurrency)} ${cur}`;
      const g = groups.get(key) ?? { group: groupKeyFor(row, groupBy, fallbackCurrency), currency: cur, count: 0 };
      g.count++;
      for (const f of SUM_FIELDS) {
        const n = num(row[f]);
        if (n !== null) g[f] = round2((g[f] ?? 0) + n);
      }
      groups.set(key, g);
    }
  }

  let grouped;
  if (groupBy) {
    grouped = [...groups.values()];
    // Ageing reads as a sequence; everything else is most useful largest-first.
    if (groupBy === "aging") {
      grouped.sort((a, b) => AGING_ORDER.indexOf(a.group) - AGING_ORDER.indexOf(b.group));
    } else if (groupBy === "month") {
      grouped.sort((a, b) => String(a.group).localeCompare(String(b.group)));
    } else {
      grouped.sort((a, b) => (b.total ?? b.amount ?? b.count) - (a.total ?? a.amount ?? a.count));
    }
  }

  return {
    totals_by_currency: byCurrency,
    ...(Object.keys(byStatus).length && { count_by_status: byStatus }),
    ...(grouped && {
      grouped_by: groupBy,
      group_count: grouped.length,
      ...(grouped.length > MAX_GROUPS && {
        groups_truncated: `Showing the top ${MAX_GROUPS} of ${grouped.length}; totals_by_currency above remains complete.`,
      }),
      groups: grouped.slice(0, MAX_GROUPS),
    }),
  };
}

/**
 * Runs the same read against several organizations and merges the rows.
 *
 * Zoho Books has no cross-organization endpoint — every call is scoped to exactly one
 * organization_id — so "company-wide" answers have to be assembled here by querying each
 * one and combining. Rows are tagged with their origin, and differing currencies are
 * flagged rather than silently added together.
 */
async function listAcrossOrgs(userId, { path, query, orgIds, summarize, groupBy }) {
  const orgResp = await zohoRequest(userId, { method: "GET", path: "/organizations", noOrg: true });
  if (!orgResp.ok) return orgResp;

  let orgs = orgResp.data?.organizations ?? [];
  if (orgIds?.length) {
    const want = new Set(orgIds.map(String));
    const matched = orgs.filter((o) => want.has(String(o.organization_id)));
    if (!matched.length) {
      return {
        ok: false,
        text:
          `This user has no access to organization(s): ${[...want].join(", ")}. ` +
          `Call ZohoBooks_list_organizations to see which are available.`,
      };
    }
    orgs = matched;
  }
  if (!orgs.length) {
    return { ok: false, text: "This user has no accessible Zoho Books organizations." };
  }

  // Summary mode: read every page per organization, return aggregates only. Complete
  // figures in a small payload — the whole point, since raw rows overflow the limit.
  if (summarize) {
    const perOrg = [];
    for (let i = 0; i < orgs.length; i += 2) {
      const batch = orgs.slice(i, i + 2);
      perOrg.push(
        ...(await Promise.all(
          batch.map(async (o) => {
            const f = await fetchAllPages(userId, { path, query, orgId: o.organization_id });
            const base = {
              organization_id: o.organization_id,
              organization_name: o.name,
              organization_currency: o.currency_code,
            };
            if (f.error) return { ...base, error: f.error, figures_complete: false };
            return {
              ...base,
              record_count: f.rows.length,
              figures_complete: f.complete,
              ...(f.complete
                ? {}
                : { note: `Stopped at ${MAX_PAGES} pages (${f.rows.length} records); narrow by date range.` }),
              ...aggregate(f.rows, o.currency_code, groupBy),
            };
          })
        ))
      );
    }

    const grand = {};
    for (const o of perOrg) {
      for (const [cur, vals] of Object.entries(o.totals_by_currency ?? {})) {
        const g = (grand[cur] ??= { count: 0 });
        for (const [k, v] of Object.entries(vals)) g[k] = round2((g[k] ?? 0) + v);
      }
    }

    const currencies = Object.keys(grand);
    const anyIncomplete = perOrg.some((o) => o.figures_complete === false);

    return {
      ok: true,
      text: JSON.stringify(
        {
          mode: "summary",
          organizations: perOrg,
          grand_total_by_currency: grand,
          ...(currencies.length > 1 && {
            currency_note:
              `Totals are grouped by currency (${currencies.join(", ")}) and deliberately NOT ` +
              `combined. Report each currency separately; only convert if the user supplies rates.`,
          }),
          ...(anyIncomplete && {
            warning: "At least one organization hit the page cap — see figures_complete per organization.",
          }),
          figures_are_complete: !anyIncomplete,
        },
        null,
        2
      ),
    };
  }

  // Zoho rate-limits per organization; a few at a time keeps well clear of the ceiling.
  const out = [];
  for (let i = 0; i < orgs.length; i += 3) {
    const batch = orgs.slice(i, i + 3);
    out.push(
      ...(await Promise.all(
        batch.map(async (o) => ({
          org: o,
          r: await zohoRequest(userId, {
            method: "GET",
            path,
            query: { ...query, organization_id: o.organization_id },
          }),
        }))
      ))
    );
  }

  let key = "records";
  const rows = [];
  const summary = [];
  for (const { org, r } of out) {
    const base = {
      organization_id: org.organization_id,
      organization_name: org.name,
      currency_code: org.currency_code,
    };
    // One organization failing (permissions, for instance) must not lose the others.
    if (!r.ok) {
      summary.push({ ...base, error: r.text });
      continue;
    }
    const ex = extractRows(r.data);
    if (ex) key = ex.key;
    const got = ex?.rows ?? [];
    summary.push({ ...base, count: got.length });
    for (const row of got) {
      rows.push({
        ...row,
        _organization_id: org.organization_id,
        _organization_name: org.name,
        _currency_code: org.currency_code,
      });
    }
  }

  const currencies = [...new Set(summary.map((s) => s.currency_code).filter(Boolean))];
  const payload = {
    queried_organizations: summary,
    total_records: rows.length,
    ...(currencies.length > 1 && {
      currency_warning:
        `These organizations report in different currencies (${currencies.join(", ")}). ` +
        `Do not add amounts across them without converting — give per-organization subtotals ` +
        `and state the currency for each.`,
    }),
    [key]: rows,
  };

  let text = JSON.stringify(payload, null, 2);
  if (text.length > MAX_CHARS) {
    // Trim rows rather than slicing the JSON, so the per-organization summary survives.
    let keep = rows.length;
    while (keep > 1 && text.length > MAX_CHARS) {
      keep = Math.floor(keep * 0.6);
      text = JSON.stringify(
        {
          ...payload,
          [key]: rows.slice(0, keep),
          truncated:
            `Showing ${keep} of ${rows.length} records — these rows are INCOMPLETE, do not total ` +
            `them. For any sum, count or "how much" question, call this tool again with ` +
            `summarize: true, which returns complete server-computed totals. Otherwise narrow ` +
            `with filter_by or a date range via params.`,
        },
        null,
        2
      );
    }
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Entity table
// ---------------------------------------------------------------------------

const ENTITIES = [
  {
    single: "contact",
    plural: "contacts",
    path: "/contacts",
    id: "contact_id",
    noun: "contact (a customer or a vendor)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: contact_name. Common: company_name, contact_type ('customer' or 'vendor'), " +
      "currency_id, payment_terms, payment_terms_label, credit_limit, notes, " +
      "billing_address{address,street2,city,state,zip,country,phone}, shipping_address{...}, " +
      "contact_persons[{salutation,first_name,last_name,email,phone,mobile,is_primary_contact}], " +
      "custom_fields[{label,value}].",
  },
  {
    single: "invoice",
    plural: "invoices",
    path: "/invoices",
    id: "invoice_id",
    noun: "invoice",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id and line_items[]. Each line item: " +
      "{item_id, name, description, rate, quantity, unit, tax_id, discount, item_order}. " +
      "Common: invoice_number, reference_number, date (YYYY-MM-DD), due_date, payment_terms, " +
      "discount, is_discount_before_tax, discount_type, is_inclusive_tax, salesperson_name, " +
      "notes, terms, custom_fields[{label,value}].",
  },
  {
    single: "estimate",
    plural: "estimates",
    path: "/estimates",
    id: "estimate_id",
    noun: "estimate (quote)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id and line_items[]. Each line item: " +
      "{item_id, name, description, rate, quantity, tax_id, item_order}. " +
      "Common: estimate_number, reference_number, date, expiry_date, discount, " +
      "is_inclusive_tax, salesperson_name, notes, terms, custom_fields[{label,value}].",
  },
  {
    single: "sales_order",
    plural: "sales_orders",
    path: "/salesorders",
    id: "salesorder_id",
    noun: "sales order",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id and line_items[]. Common: salesorder_number, reference_number, " +
      "date, shipment_date, discount, is_inclusive_tax, salesperson_name, notes, terms, " +
      "custom_fields[{label,value}].",
  },
  {
    single: "purchase_order",
    plural: "purchase_orders",
    path: "/purchaseorders",
    id: "purchaseorder_id",
    noun: "purchase order",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: vendor_id and line_items[]. Common: purchaseorder_number, reference_number, " +
      "date, delivery_date, discount, is_inclusive_tax, notes, terms, " +
      "custom_fields[{label,value}].",
  },
  {
    single: "item",
    plural: "items",
    path: "/items",
    id: "item_id",
    noun: "item (product or service)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: name. Common: rate, description, sku, unit, product_type ('goods' or 'service'), " +
      "item_type ('sales', 'purchases', 'sales_and_purchases', 'inventory'), tax_id, " +
      "account_id, purchase_rate, purchase_account_id, purchase_description, " +
      "initial_stock, initial_stock_rate, custom_fields[{label,value}].",
  },
  {
    single: "expense",
    plural: "expenses",
    path: "/expenses",
    id: "expense_id",
    noun: "expense",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: account_id (the expense account) and amount. Common: date, paid_through_account_id, " +
      "vendor_id, customer_id, currency_id, exchange_rate, tax_id, is_inclusive_tax, " +
      "is_billable, reference_number, description, project_id, custom_fields[{label,value}].",
  },
  {
    single: "customer_payment",
    plural: "customer_payments",
    path: "/customerpayments",
    id: "payment_id",
    noun: "customer payment (payment received)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id, payment_mode, amount, date. Common: reference_number, description, " +
      "exchange_rate, account_id (deposit-to account), bank_charges, " +
      "invoices[{invoice_id, amount_applied, tax_amount_withheld}], custom_fields[{label,value}].",
  },
  // --- Payables. Without these the ledger only shows money owed TO the company. ---
  {
    single: "bill",
    plural: "bills",
    path: "/bills",
    id: "bill_id",
    noun: "bill (an invoice received from a supplier — what the company owes)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: vendor_id and line_items[]. Each line item: {account_id, name, description, " +
      "rate, quantity, tax_id}. Common: bill_number, reference_number, date, due_date, " +
      "payment_terms, is_inclusive_tax, notes, custom_fields[{label,value}].",
  },
  {
    single: "vendor_payment",
    plural: "vendor_payments",
    path: "/vendorpayments",
    id: "payment_id",
    noun: "vendor payment (money paid out to a supplier)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: vendor_id, amount, date, paid_through_account_id. Common: payment_mode, " +
      "reference_number, description, exchange_rate, bills[{bill_id, amount_applied}].",
  },
  {
    single: "vendor_credit",
    plural: "vendor_credits",
    path: "/vendorcredits",
    id: "vendor_credit_id",
    noun: "vendor credit (a credit note received from a supplier)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: vendor_id and line_items[]. Common: vendor_credit_number, date, " +
      "reference_number, notes, custom_fields[{label,value}].",
  },
  // --- Credit notes reduce revenue; without them invoice totals read high. ---
  {
    single: "credit_note",
    plural: "credit_notes",
    path: "/creditnotes",
    id: "creditnote_id",
    noun: "credit note (a refund or cancellation issued to a customer, reducing revenue)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id and line_items[]. Common: creditnote_number, date, " +
      "reference_number, reason, is_inclusive_tax, notes, custom_fields[{label,value}].",
  },
  {
    single: "journal",
    plural: "journals",
    path: "/journals",
    id: "journal_id",
    noun: "manual journal entry",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: journal_date and line_items[] where debits equal credits. Each line: " +
      "{account_id, debit_or_credit ('debit'|'credit'), amount, description, customer_id}. " +
      "Common: reference_number, notes, journal_type, currency_id, exchange_rate.",
  },
  {
    single: "bank_transaction",
    plural: "bank_transactions",
    path: "/banktransactions",
    id: "transaction_id",
    noun: "bank or credit-card transaction",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: account_id, transaction_type, amount, date. transaction_type is one of " +
      "'deposit', 'refund', 'expense', 'card_payment', 'sales_without_invoices', " +
      "'owner_contribution', 'transfer_fund', 'owner_drawings'. Common: payment_mode, " +
      "reference_number, description, from_account_id, to_account_id.",
  },
  {
    single: "recurring_invoice",
    plural: "recurring_invoices",
    path: "/recurringinvoices",
    id: "recurring_invoice_id",
    noun: "recurring invoice profile",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id, recurrence_name, recurrence_frequency ('days'|'weeks'|'months'|" +
      "'years'), start_date and line_items[]. Common: repeat_every, end_date, payment_terms.",
  },
  {
    single: "tax",
    plural: "taxes",
    path: "/settings/taxes",
    id: "tax_id",
    noun: "tax rate",
    ops: ["get", "list", "create"],
    hint:
      "Required: tax_name and tax_percentage. Common: tax_type ('tax' or 'compound_tax'), " +
      "tax_authority_id, tax_specific_type, country, is_value_added, is_default_tax.",
  },
  {
    single: "user",
    plural: "users",
    path: "/users",
    id: "user_id",
    noun: "Zoho Books user",
    ops: ["get", "list"],
  },
  {
    single: "organization",
    plural: "organizations",
    path: "/organizations",
    id: "organization_id",
    noun: "Zoho Books organization",
    // list_organizations is defined by hand below so it can report which org is active.
    ops: ["get"],
    noOrg: true,
  },
  {
    single: "bank_account",
    plural: "bank_accounts",
    path: "/bankaccounts",
    noun: "bank or credit-card account",
    ops: ["list"],
  },
  {
    single: "chart_of_account",
    plural: "chart_of_accounts",
    path: "/chartofaccounts",
    noun: "chart-of-accounts entry",
    ops: ["list"],
  },
  {
    single: "currency",
    plural: "currencies",
    path: "/settings/currencies",
    noun: "currency configured in the organization",
    ops: ["list"],
  },
];

// ---------------------------------------------------------------------------
// Module registry
//
// One tool per entity per operation meant the tool count grew five at a time and
// eventually exceeded what an MCP client will reliably hold — capability started
// disappearing silently. Instead the entity table above becomes a registry, and a
// small fixed set of generic tools takes `module` as a parameter. Adding a Zoho
// module later is one more enum value, never another tool.
// ---------------------------------------------------------------------------

const tools = [];
const add = (name, description, schema, run, write = false) => {
  if (write && READ_ONLY) return;
  tools.push({ name: PREFIX + name, description, schema, run });
};

const MODULES = {};
for (const e of ENTITIES) {
  MODULES[e.plural] = {
    path: e.path,
    idField: e.id,
    ops: e.ops,
    noun: e.noun,
    hint: e.hint,
    noOrg: Boolean(e.noOrg),
  };
}

MODULES.custom_fields = {
  path: "/settings/fields",
  idField: "field_id",
  ops: ["list", "create", "update"],
  noun: "custom field definition",
  hint:
    "Required: label, data_type, entity. data_type is one of 'string', 'text', 'number', " +
    "'decimal', 'percent', 'amount', 'date', 'email', 'url', 'phone', 'check_box', " +
    "'dropdown', 'multiselect', 'autonumber', 'lookup'. Common: show_on_pdf, is_mandatory, " +
    "help_text, default_value, values[].",
  listNote:
    "Listing requires the target module, passed through params, " +
    'e.g. params: {"entity":"invoice"}.',
};

MODULES.custom_modules = {
  path: "/settings/modules",
  idField: "module_api_name",
  ops: ["list", "get", "create", "update"],
  noun: "custom module definition",
  hint:
    "Required: module_name (singular label), module_name_plural, api_name. Common: " +
    "description, fields[{label,data_type,is_mandatory}], is_active.",
};

MODULES.custom_module_records = {
  dynamic: true,
  idField: "record_id",
  ops: ["list", "get", "create"],
  noun: "record stored inside a custom module",
  hint:
    "Keys are the module's own field API names; custom fields are prefixed 'cf_', " +
    'e.g. {"cf_project_name":"Jabal Akhdar","cf_budget":250000}.',
  listNote: "Requires module_api_name. Call list with module 'custom_modules' to discover it.",
};

const MODULE_NAMES = Object.keys(MODULES).sort();

const moduleArg = {
  module: z
    .enum(MODULE_NAMES)
    .describe(
      "Which Zoho Books module to act on. Money owed TO you: invoices, customer_payments, " +
        "credit_notes. Money you OWE: bills, vendor_payments, vendor_credits. Also: contacts, " +
        "estimates, sales_orders, purchase_orders, items, expenses, journals, bank_transactions, " +
        "bank_accounts, chart_of_accounts, taxes, users, organizations, recurring_invoices, " +
        "currencies, custom_fields, custom_modules, custom_module_records."
    ),
};

const moduleApiNameArg = {
  module_api_name: z
    .string()
    .optional()
    .describe("Only for module 'custom_module_records': the custom module's api_name."),
};

/** Resolves a module to its endpoint, rejecting unsupported combinations clearly. */
function resolve(moduleName, op, args) {
  const m = MODULES[moduleName];
  if (!m) {
    return { error: `Unknown module "${moduleName}". Valid: ${MODULE_NAMES.join(", ")}.` };
  }
  if (!m.ops.includes(op)) {
    return {
      error:
        `Zoho Books does not support ${op} on ${moduleName}. ` +
        `Supported here: ${m.ops.join(", ")}.`,
    };
  }
  if (m.dynamic) {
    if (!args.module_api_name) {
      return {
        error:
          `module_api_name is required for ${moduleName}. ` +
          `Call list with module "custom_modules" to find it.`,
      };
    }
    return { m, base: `/${seg(args.module_api_name)}` };
  }
  return { m, base: m.path };
}

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

add(
  "list",
  "List or summarise records from any Zoho Books module. This is the main read tool.\n\n" +
    "For totals, counts, revenue, outstanding balances or 'how many' questions, set " +
    "summarize: true — the server reads every page and returns complete, exact aggregates " +
    "in a small response. Listing raw records to add up yourself silently truncates.\n\n" +
    "Use group_by for breakdowns that stay complete at any volume: 'customer' (top clients), " +
    "'vendor' (supplier spend), 'month' (trends), 'status', or 'aging' (a receivables or " +
    "payables ageing report). Set all_organizations: true for company-wide questions spanning " +
    "every country or entity.",
  { ...moduleArg, ...moduleApiNameArg, ...listArgs },
  async (args, userId) => {
    const r = resolve(args.module, "list", args);
    if (r.error) return fail(r.error);
    const { m, base } = r;

    const query = buildQuery({ ...args, module: undefined, module_api_name: undefined });
    const wantSummary = Boolean(args.summarize || args.group_by);

    if (!m.noOrg && (args.all_organizations || args.organization_ids?.length || wantSummary)) {
      const orgIds =
        args.organization_ids ??
        (args.all_organizations
          ? undefined
          : args.organization_id
            ? [args.organization_id]
            : [String((await db.getUser(userId))?.default_org_id ?? "")].filter(Boolean));
      return result(
        await listAcrossOrgs(userId, {
          path: base,
          query: { ...query, organization_id: undefined },
          orgIds,
          summarize: wantSummary,
          groupBy: args.group_by,
        })
      );
    }

    return result(await zohoRequest(userId, { method: "GET", path: base, query, noOrg: m.noOrg }));
  }
);

add(
  "get",
  "Retrieve one record from any Zoho Books module by its ID, with full detail. " +
    "Find the ID first with the list tool — never guess one.",
  {
    ...moduleArg,
    record_id: z.string().describe("The record's Zoho ID. Use list to find it."),
    ...moduleApiNameArg,
    ...orgArg,
  },
  async (args, userId) => {
    const r = resolve(args.module, "get", args);
    if (r.error) return fail(r.error);
    const { m, base } = r;
    return result(
      await zohoRequest(userId, {
        method: "GET",
        path: `${base}/${seg(args.record_id)}`,
        query: buildQuery({ organization_id: args.organization_id }),
        noOrg: m.noOrg,
      })
    );
  }
);

add(
  "describe_module",
  "Show what a module expects before writing to it: its required and commonly used fields, " +
    "which operations it supports, and what its ID field is called. Call this before create " +
    "or update if you are unsure of the field names.",
  { ...moduleArg },
  async (args) => {
    const m = MODULES[args.module];
    if (!m) return fail(`Unknown module "${args.module}". Valid: ${MODULE_NAMES.join(", ")}.`);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              module: args.module,
              description: m.noun,
              supported_operations: m.ops,
              id_field_in_zoho: m.idField,
              required_and_common_fields: m.hint ?? "No writable fields — this module is read-only here.",
              ...(m.listNote && { note: m.listNote }),
            },
            null,
            2
          ),
        },
      ],
      isError: false,
    };
  }
);

add(
  "create",
  "Create a record in any Zoho Books module. Call describe_module first if unsure which " +
    "fields are required.",
  {
    ...moduleArg,
    data: z.record(z.string(), z.any()).describe("The record body as a JSON object."),
    ...moduleApiNameArg,
    ...orgArg,
  },
  async (args, userId) => {
    const r = resolve(args.module, "create", args);
    if (r.error) return fail(r.error);
    return result(
      await zohoRequest(userId, {
        method: "POST",
        path: r.base,
        query: buildQuery({ organization_id: args.organization_id }),
        body: args.data,
      })
    );
  },
  true
);

add(
  "update",
  "Update a record in any Zoho Books module. Send only the fields you want to change — " +
    "except line_items, which Zoho replaces wholesale, so include every line.",
  {
    ...moduleArg,
    record_id: z.string().describe("The record's Zoho ID."),
    data: z.record(z.string(), z.any()).describe("Fields to change, as a JSON object."),
    ...moduleApiNameArg,
    ...orgArg,
  },
  async (args, userId) => {
    const r = resolve(args.module, "update", args);
    if (r.error) return fail(r.error);
    return result(
      await zohoRequest(userId, {
        method: "PUT",
        path: `${r.base}/${seg(args.record_id)}`,
        query: buildQuery({ organization_id: args.organization_id }),
        body: args.data,
      })
    );
  },
  true
);

add(
  "delete",
  "Permanently delete a record from any Zoho Books module. This cannot be undone — confirm " +
    "with the user first, and verify the ID with get or list before calling.",
  {
    ...moduleArg,
    record_id: z.string().describe("The record's Zoho ID. Verify it before deleting."),
    ...moduleApiNameArg,
    ...orgArg,
  },
  async (args, userId) => {
    const r = resolve(args.module, "delete", args);
    if (r.error) return fail(r.error);
    return result(
      await zohoRequest(userId, {
        method: "DELETE",
        path: `${r.base}/${seg(args.record_id)}`,
        query: buildQuery({ organization_id: args.organization_id }),
      })
    );
  },
  true
);

// ---------------------------------------------------------------------------
// Organizations — kept as dedicated tools. Which organization is active decides
// what every other call returns, so it must be obvious rather than buried behind
// a module parameter.
// ---------------------------------------------------------------------------

add(
  "list_organizations",
  "List every Zoho Books organization this user can access, and show which one the other " +
    "tools currently read from. Call this whenever results look unexpectedly empty, or before " +
    "answering a question that spans countries or entities.",
  {},
  async (_args, userId) => {
    const r = await zohoRequest(userId, { method: "GET", path: "/organizations", noOrg: true });
    if (!r.ok) return result(r);

    const user = await db.getUser(userId);
    const active = user?.default_org_id ?? null;
    const orgs = (r.data?.organizations ?? []).map((o) => ({
      organization_id: o.organization_id,
      name: o.name,
      currency_code: o.currency_code,
      is_active_for_these_tools: String(o.organization_id) === String(active),
    }));

    let text = JSON.stringify({ active_organization_id: active, organizations: orgs }, null, 2);
    if (orgs.length > 1) {
      text +=
        `\n\nThis user belongs to ${orgs.length} organizations. Tools read from ` +
        `${active ?? "(none set)"} unless organization_id is passed. For company-wide ` +
        `questions use all_organizations: true on the list tool rather than switching.`;
    }
    return { content: [{ type: "text", text }], isError: false };
  }
);

add(
  "set_default_organization",
  "Change which Zoho Books organization this user's tools read from by default. Persists " +
    "until changed again. For one-off cross-entity questions prefer all_organizations on the " +
    "list tool instead of switching the default.",
  {
    organization_id: z
      .string()
      .describe("The organization_id to make active, from ZohoBooks_list_organizations."),
  },
  async (args, userId) => {
    const r = await zohoRequest(userId, { method: "GET", path: "/organizations", noOrg: true });
    if (!r.ok) return result(r);

    const match = (r.data?.organizations ?? []).find(
      (o) => String(o.organization_id) === String(args.organization_id)
    );
    if (!match) {
      return fail(
        `This user has no access to organization ${args.organization_id}. ` +
          `Call ZohoBooks_list_organizations to see the available ones.`
      );
    }

    await db.setDefaultOrg(userId, String(match.organization_id));
    return {
      content: [
        {
          type: "text",
          text: `Active organization is now "${match.name}" (${match.organization_id}).`,
        },
      ],
      isError: false,
    };
  }
);

export default tools;
export { READ_ONLY, MODULE_NAMES };

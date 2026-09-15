import { z } from "zod";
import { money, currency, validDate, validateSpec, fingerprint, reconcileEvidence } from "./reporting.js";
import { definitionFor, currentDate } from "./report-definitions.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const date = z.string().refine(validDate);
const timezone = z.string().refine(value => { try { currentDate(value); return true; } catch { return false; } });
const specSchema = z.object({ kind: z.enum(["collections", "receivables", "source_field", "historical_receivables"]), module: z.string(), metric: z.string(), currency_basis: z.enum(["base", "transaction"]),
  date_start: date.optional(), date_end: date.optional(), as_of: date.optional(), group_by: z.string().optional(), statuses: z.array(z.string()).optional(), customer_id: id.optional(), vendor_id: id.optional(), search_text: z.string().optional(), module_api_name: id.optional() }).strict();
export const referenceSchema = z.object({ schema_version: z.literal(1), label: z.string().min(1).max(300),
  source: z.object({ type: z.enum(["zoho_export", "finance_export", "synthetic_fixture"]), report_name: z.string().min(1).max(300), exported_at: z.string().datetime({ offset: true }), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  approval: z.object({ approved_by: z.string().min(1).max(200), approved_at: z.string().datetime({ offset: true }) }).strict(),
  definition_id: z.string(), spec: specSchema,
  organizations: z.array(z.object({ organization_id: id, name: z.string().min(1), currency_code: z.string().refine(v => Boolean(currency(v))), time_zone: timezone }).strict()).min(1).max(100),
  records: z.array(z.object({ organization_id: id, record_id: id, currency: z.string().refine(v => Boolean(currency(v))), amount: z.string().refine(v => { try { money(v); return true; } catch { return false; } }), customer_name: z.string().max(500).optional() }).strict()).max(100000),
}).strict();
export function validateReference(input, { allowSynthetic = false } = {}) {
  const ref = referenceSchema.parse(input);
  const exported = Date.parse(ref.source.exported_at), approved = Date.parse(ref.approval.approved_at);
  if (exported > Date.now() || approved > Date.now() || approved < exported) throw new Error("Reference export and approval timestamps must be ordered and not in the future");
  if (!allowSynthetic && ref.source.type === "synthetic_fixture") throw new Error("Synthetic fixtures cannot be installed as finance-approved references");
  if (definitionFor(ref.spec).id !== ref.definition_id) throw new Error("Reference definition does not match the report specification");
  if (ref.spec.kind === "historical_receivables") {
    if (ref.spec.module !== "contacts" || ref.spec.metric !== "closing_balance" || !ref.spec.as_of || ref.spec.date_start || ref.spec.date_end || ref.spec.statuses || ref.spec.customer_id || ref.spec.vendor_id || ref.spec.search_text || ref.spec.module_api_name || ref.spec.group_by !== "customer") throw new Error("Historical references require customer closing balances and an explicit as_of date; filters are unsupported");
  } else validateSpec(ref.spec);
  const orgIds = ref.organizations.map(o => o.organization_id);
  if (ref.spec.as_of && ref.organizations.some(o => ref.spec.as_of > currentDate(o.time_zone, new Date(exported)))) throw new Error("Reference cutoff cannot be later than the source export's local date");
  if (new Set(orgIds).size !== orgIds.length) throw new Error("Duplicate reference organizations");
  if (ref.records.some(r => !orgIds.includes(r.organization_id))) throw new Error("Reference record outside the declared entity scope");
  if (ref.spec.currency_basis === "base" && ref.records.some(r => r.currency !== ref.organizations.find(o => o.organization_id === r.organization_id).currency_code)) throw new Error("Reference base currency differs from the declared entity currency");
  reconcileEvidence([], ref.records); // Also rejects duplicate identity keys.
  return ref;
}
export function referenceKey(spec, organizations) {
  return fingerprint({ definition: definitionFor(spec).id, spec, organizations: organizations.map(o => String(o.organization_id ?? o.id)).sort() });
}
export function compareReference(snapshot, result, reference, now = Date.now()) {
  const ref = validateReference(reference);
  if (!result.summary.figures_are_complete) throw new Error("Only complete validated reports can be compared");
  if (referenceKey(snapshot.spec, snapshot.organizations) !== referenceKey(ref.spec, ref.organizations)) throw new Error("Reference dates, scope, filters, currency basis or definition do not match");
  if (ref.spec.kind === "receivables" || ref.spec.metric === "balance") {
    // A old current-balance export cannot certify a new current-balance report.
    const exported = Date.parse(ref.source.exported_at), started = Date.parse(snapshot.started_at);
    if (exported > now || Math.abs(started - exported) > 300000) throw new Error("Current-balance reference must be within five minutes of report retrieval; historical exports cannot validate current balances");
  }
  const comparison = reconcileEvidence(result.evidence, ref.records);
  return { ...comparison, reference_label: ref.label, reference_fingerprint: fingerprint(ref), definition_id: ref.definition_id,
    source_exported_at: ref.source.exported_at, compared_at: new Date(now).toISOString(), approval: ref.approval,
    provenance: "Operator-approved imported reference; source authenticity is not independently certified" };
}
export function historicalResult(ref, referenceId) {
  validateReference(ref);
  if (ref.spec.kind !== "historical_receivables") throw new Error("Reference is not a historical customer balance report");
  const buckets = new Map();
  for (const row of ref.records) {
    const key = JSON.stringify([row.organization_id, row.currency]);
    const prev = buckets.get(key) || { organization_id: row.organization_id, currency: row.currency, amount: money("0") };
    prev.amount = prev.amount.plus(money(row.amount)); buckets.set(key, prev);
  }
  return { reference_id: referenceId, source: ref.source, definition: definitionFor(ref.spec), specification: ref.spec,
    organizations: ref.organizations, approval: ref.approval, result_basis: "Operator-approved imported historical report; not a live Zoho retrieval",
    reconciliation_status: "imported_reference_not_independently_reconciled", records: ref.records,
    totals: [...buckets.values()].map(b => ({ ...b, amount: b.amount.toFixed() })) };
}

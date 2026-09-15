// Versioned definitions describe implemented calculations, not finance approval.
export const DEFINITIONS = Object.freeze({
  gross_collections_v1: { id: "gross_collections_v1", name: "Gross customer receipts", date_basis: "payment receipt date", source: "customer_payments.amount", exclusions: "No independent netting of refunds, fees, withholding or allocations" },
  current_receivables_v1: { id: "current_receivables_v1", name: "Current customer receivables", date_basis: "current balance at retrieval", source: "contacts.outstanding_receivable_amount", exclusions: "No independent subtraction of unused credits; active and inactive customers included" },
  historical_receivables_v1: { id: "historical_receivables_v1", name: "Historical customer closing balances", date_basis: "explicit as_of date and timezone in an operator-approved source export", source: "imported customer balance or aging report", exclusions: "Never reconstructed from current invoice balances" },
  source_field_v1: { id: "source_field_v1", name: "Explicit source field", date_basis: "document date filters; balances remain current", source: "explicit module and metric", exclusions: "Not recognized revenue or consolidated accounts" },
});
export function definitionFor(spec) {
  return DEFINITIONS[spec.kind === "collections" ? "gross_collections_v1" : spec.kind === "receivables" ? "current_receivables_v1" : spec.kind === "historical_receivables" ? "historical_receivables_v1" : "source_field_v1"];
}
export function currentDate(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = key => parts.find(p => p.type === key).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function expectedOrganizations() {
  const value = process.env.EXPECTED_ORGANIZATION_IDS?.trim();
  if (!value) return [];
  const ids = value.split(",").map(id => id.trim());
  if (ids.some(id => !/^[A-Za-z0-9_-]{1,200}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error("Invalid EXPECTED_ORGANIZATION_IDS configuration");
  return ids;
}
export function entityCoverage(available, requested, expected = expectedOrganizations()) {
  const accessible = new Set(available.map(o => String(o.organization_id)));
  const selected = new Set(requested);
  return { status: !expected.length ? "expected_entities_not_configured" : expected.every(id => accessible.has(id) && selected.has(id)) ? "all_expected_entities_covered" : "incomplete_expected_entity_coverage",
    expected_ids: expected, requested_ids: [...selected], missing_access_ids: expected.filter(id => !accessible.has(id)),
    omitted_ids: expected.filter(id => !selected.has(id)), extra_accessible_ids: [...accessible].filter(id => !expected.includes(id)) };
}

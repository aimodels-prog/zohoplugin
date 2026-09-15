// Completion and pagination are explicit so a client cannot mistake a checkpoint
// or an empty partial group list for a financial answer.
export function reportResponse(result, backgroundJob = null) {
  const s = result.summary;
  const status = s.figures_are_complete ? "complete" : s.continuation_available ? "processing" : "failed_validation";
  const response = { ...s, status, background_job: backgroundJob,
    next_action: status === "processing" ? { tool: "ZohoBooks_continue_report", arguments: { report_id: s.report_id },
      instruction: "Call this tool automatically using the same report_id until processing finishes. Do not ask the user to continue, start a replacement report, or present partial totals/rankings." } : null };
  if(s.specification.metric==="count") {
    response.amounts_calculated=false;
    response.metric_warning="This is a document count. It contains no calculated outstanding amounts and cannot answer or rank customers by receivables.";
    if(s.specification.module==="invoices")response.tool_for_customer_receivables={tool:"ZohoBooks_receivables_report",arguments:{organization_ids:s.organizations.map(o=>o.organization_id),currency_basis:"base"}};
  }
  if (status === "failed_validation") response.instruction = "No final total or ranking is available. Inspect validation_errors and organization errors; do not treat missing results as zero.";
  if (s.figures_are_complete && s.specification.group_by) {
    response.groups = result.groups.slice(0, 50);
    response.groups_returned = response.groups.length;
    response.groups_complete = response.groups.length === result.groups.length;
    if (!response.groups_complete) response.next_action = { tool: "ZohoBooks_get_report", arguments: { report_id: s.report_id, section: "groups", page: 2, per_page: 50 }, instruction: "The full population is verified. Retrieve additional already-calculated groups with this tool; do not recalculate from raw pages." };
  }
  return response;
}

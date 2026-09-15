import { randomUUID } from 'node:crypto';
import { VERSION, BUILD_ID } from './security.js';

export const failureOutcomes = ['error', 'schema_error', 'unknown_tool', 'verification_failed', 'concurrency_limited', 'failed'];

export function diagnostic(code, reportId) {
  return { reference: randomUUID(), code, version: VERSION, build_id: BUILD_ID,
    ...(typeof reportId === 'string' && /^[0-9a-f-]{36}$/i.test(reportId) && { report_id: reportId }) };
}

export function inputFailure(tool, parsed) {
  const info = diagnostic(tool ? 'schema_error' : 'unknown_tool');
  // Do not log/echo supplied values, unexpected field names, or customer data.
  const fields = tool ? [...new Set(parsed.error.issues.map(issue => {
    const [first, second] = issue.path;
    if (!Object.hasOwn(tool.schema, first)) return 'arguments';
    return first === 'params' && /^[a-z_]+$/.test(second || '') ? 'params' : first;
  }))] : [];
  return { info, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({
    ...info, message: tool ? 'Tool inputs do not match the supported schema. Correct the inputs before retrying.' : 'This tool name is not available on this server. Discover the available tools before retrying.',
    fields,
    ...(tool?.name === 'ZohoBooks_list' && { supported_report_options: {
      invoice_balances: { module: 'invoices', params: { metric: 'balance' } },
      customer_receivables: { module: 'contacts', params: { report_type: 'receivables' } },
      instruction: 'Keep the explicit organization scope. Use only supported report options; do not silently drop requested accounting filters.'
    } })
  }) }] } };
}

export function resultOutcome(result) {
  if (result.isError) return { outcome: 'error' };
  // Inspect only authored result envelopes, never financial source rows.
  for (const block of result.content || []) {
    if (block.type !== 'text') continue;
    let value; try { value = JSON.parse(block.text); } catch { continue; }
    if (value?.status === 'failed_validation') return { outcome: 'verification_failed', report_id: value.report_id };
    if (value?.section === 'summary' && value.data?.status === 'failed_validation') return { outcome: 'verification_failed', report_id: value.report_id };
  }
  return { outcome: 'ok' };
}

export function monitorReasons(account) {
  return [
    ...(account.zoho_access !== 'ok' ? ['zoho_access_failed'] : []),
    ...(account.coverage !== 'all_expected_entities_covered' ? ['entity_coverage_incomplete'] : []),
    ...(account.jobs.some(j => j.state === 'failed') ? ['failed_report_jobs'] : []),
    ...(account.events_last_24_hours.some(e => failureOutcomes.includes(e.outcome) && e.count > 0) ? ['recent_connector_failures'] : []),
  ];
}

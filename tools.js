import { z } from "zod";
import { randomUUID } from "node:crypto";
import { zohoRequest } from "./zoho.js";
import * as db from "./db.js";
import { MODULES, MODULE_NAMES } from "./modules.js";
import { READ_ONLY, VERSION, BUILD_ID, integerSetting } from "./security.js";
import { validDate, selectOrganizations, createSnapshot, advanceSnapshot, calculate, extractRows, fingerprint, reconcileEvidence } from "./reporting.js";
import { validateWrite, recordFingerprint } from "./write-safety.js";
import { DEFINITIONS, definitionFor, expectedOrganizations, entityCoverage } from "./report-definitions.js";
import { referenceKey, compareReference, historicalResult } from "./finance-reference.js";
import { planFinanceQuestion } from "./question-plan.js";
import { createDownloadTicket } from "./report-export.js";
import { emailAllowed } from "./oauth.js";

const tools = [];
const add = (name, description, schema, run, write = false) => {
  if (write && READ_ONLY) return;
  tools.push({ name: "ZohoBooks_" + name, description, schema, run,
    annotations: { readOnlyHint: !write && name !== "set_default_organization", destructiveHint: write, openWorldHint: true, idempotentHint: !write } });
};
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, "Use an opaque identifier, not a path or URL");
const date = z.string().refine(validDate, "Use a valid YYYY-MM-DD date");
const moduleArg = { module: z.enum(MODULE_NAMES) };
const scopeArgs = { organization_id: id.optional(), organization_ids: z.array(id).min(1).max(100).optional(), all_organizations: z.boolean().optional() };
const recordArgs = { ...moduleArg, organization_id: id, module_api_name: id.optional() };
const fail = message => ({ content: [{ type: "text", text: message }], isError: true });
const textResult = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
const limit = () => integerSetting("MAX_RESPONSE_CHARS", 60000, 4000, 200000);

async function reply(value, userId) {
  if (JSON.stringify(value).length <= limit()) return textResult(value);
  const reportId = randomUUID();
  await db.saveReport(reportId, userId, { kind: "raw", value });
  return textResult({ report_id: reportId, response_stored: true,
    instruction: "Use get_report section raw to retrieve the complete stored response in pages/fragments. This pointer is not a financial result." });
}
function resolve(args, op) {
  const m = MODULES[args.module];
  if (!m?.ops.includes(op)) throw new Error(`Unsupported ${op} on ${args.module}`);
  if (m.dynamic && !args.module_api_name) throw new Error("module_api_name is required");
  if (m.dynamic && !/^cm_[A-Za-z0-9_]+$/.test(args.module_api_name)) throw new Error("Use the cm_ API name from custom_modules");
  if (m.dynamic && READ_ONLY) throw new Error("Zoho custom record access requires custommodules.ALL; it is unavailable in strict read-only mode");
  return { ...m, path: m.dynamic ? "/" + encodeURIComponent(args.module_api_name) : m.path,
    rowKey: m.rowKey };
}
async function organizations(userId) {
  const r = await zohoRequest(userId, { method: "GET", path: "/organizations", noOrg: true });
  if (!r.ok) throw new Error(r.text);
  return extractRows(r.data, "organizations");
}
async function checkOrg(userId, organizationId) {
  return selectOrganizations(await organizations(userId), { organization_id: organizationId })[0];
}
const summaryArgs = {
  metric: z.enum(["count", "amount", "total", "balance"]).default("count"),
  currency_basis: z.enum(["transaction", "base"]).default("transaction"),
  date_start: date.optional(), date_end: date.optional(),
  statuses: z.array(z.string().min(1)).min(1).optional(),
  search_text: z.string().min(1).max(200).optional().describe("Local case-insensitive substring match on names, reference/document numbers and description; implies report retrieval"),
  customer_id: id.optional(), vendor_id: id.optional(),
  group_by: z.enum(["customer", "vendor", "month", "status", "currency", "aging"]).optional(),
  as_of: date.optional(),
};
async function report(args, userId, kind = "source_field") {
  const m = resolve(args, "list");
  if (m.noOrg || !m.idField) throw new Error("This module does not support validated reports");
  const available = await organizations(userId), expected = expectedOrganizations();
  if (args.all_organizations && !expected.length) throw new Error("Expected entity IDs are not configured. An administrator must register the five entities before a report can claim all-entity coverage. Explicit organization_ids remain available.");
  if (args.all_organizations) selectOrganizations(available,args); // Reject conflicting explicit scope before substituting the registry.
  const orgs = selectOrganizations(available, args.all_organizations ? { organization_ids: expected } : args);
  const spec = { kind, module: args.module, metric: args.metric ?? "count", currency_basis: args.currency_basis ?? "transaction",
    date_start: args.date_start, date_end: args.date_end, statuses: args.statuses, group_by: args.group_by, as_of: args.as_of,
    module_api_name: args.module_api_name, search_text: args.search_text, customer_id: args.customer_id, vendor_id: args.vendor_id };
  const snapshot = createSnapshot(spec, orgs);
  snapshot.definition = definitionFor(spec);
  snapshot.entity_coverage = entityCoverage(available,orgs.map(o=>String(o.organization_id)));
  await advanceSnapshot(snapshot, m, query => zohoRequest(userId, query), integerSetting("REPORT_FOREGROUND_REQUESTS",2,1,10));
  await autoReconcile(snapshot,userId,m);
  await db.saveReport(snapshot.id, userId, snapshot);
  if(calculate(snapshot,m).summary.continuation_available)await db.enqueueReport(snapshot.id,userId,Math.max(0,...snapshot.organizations.map(o=>o.retry_after_ms||0)));
  return reply(calculate(snapshot, m).summary, userId);
}
async function autoReconcile(snapshot,userId,m) {
  const result=calculate(snapshot,m);
  if(!result.summary.figures_are_complete || snapshot.spec.metric==="count" || snapshot.reconciliation)return;
  const refs=await db.matchingReferences(referenceKey(snapshot.spec,snapshot.organizations),userId);
  snapshot.reference_check={status:refs.length?"no_comparable_reference":"no_operator_approved_reference",candidate_count:refs.length};
  for(const ref of refs) {
    let comparison;
    try {
      comparison=compareReference(snapshot,result,ref.payload);
    } catch { continue; /* A stale or differently scoped reference must not certify a report. */ }
    const {differences,...summary}=comparison;
    snapshot.reconciliation={...summary,reference_id:ref.id};snapshot.reconciliation_differences=differences;
    snapshot.reference_check={status:comparison.status,reference_id:ref.id};
    await db.recordEvent(userId,"reconciliation",comparison.status);return;
  }
}
export async function resumeReportJob(job) {
  try {
    const user=await db.getUser(job.user_id);
    if(!user||!emailAllowed(user.email))throw new Error("Account access unavailable");
    const stored=await db.getReport(job.report_id,job.user_id);
    if(!stored || stored.payload.kind==="raw") {await db.finishReportJob(job,"failed");return;}
    const s=stored.payload;
    selectOrganizations(await organizations(job.user_id),{organization_ids:s.organizations.map(o=>o.id)});
    const m=resolve(s.spec,"list");
    await advanceSnapshot(s,m,q=>zohoRequest(job.user_id,q),integerSetting("REPORT_BACKGROUND_REQUESTS",2,1,10));
    await autoReconcile(s,job.user_id,m);
    const transient=s.organizations.some(o=>o.errors.length&&!o.blocked);
    if(transient && job.failures>=4) {
      for(const org of s.organizations)if(org.errors.length&&!org.blocked){org.blocked=true;org.errors.push("Background retries exhausted; start a new report after access or service recovery");}
    }
    await db.saveReport(job.report_id,job.user_id,s,stored.revision);
    const next=calculate(s,m).summary;
    await db.finishReportJob(job,next.continuation_available?"queued":next.figures_are_complete?"complete":"failed",transient,Math.max(0,...s.organizations.map(o=>o.retry_after_ms||0)));
    if(!next.continuation_available)await db.recordEvent(job.user_id,"report",next.figures_are_complete?"complete":"failed");
    return next;
  } catch {
    if(job.failures>=4) {
      const current=await db.getReport(job.report_id,job.user_id);
      if(current&&current.payload.kind!=="raw") {
        for(const org of current.payload.organizations)if(!org.verified){org.blocked=true;org.errors=["Background retries exhausted; restore access and start a new report"];}
        await db.saveReport(job.report_id,job.user_id,current.payload,current.revision);
      }
    }
    await db.finishReportJob(job,job.failures>=4?"failed":"queued",true);
    await db.recordEvent(job.user_id,"report_job","error");
  }
}
add("collections_report",
  "Gross customer-payment receipts by payment date, not invoice date or net bank deposits. Explicit scope and inclusive dates required. Base mode uses Zoho's recorded bcy_amount; no guessed currency or exchange rate. Returns exact decimal strings, validation status and a report_id for receipt evidence. Continue incomplete retrieval with continue_report. Not reconciled with finance until externally compared.",
  { ...scopeArgs, date_start: date, date_end: date, currency_basis: z.enum(["base", "transaction"]).default("base"),
    group_by: z.enum(["customer", "month", "status", "currency"]).optional() },
  (args, userId) => report({ ...args, module: "customer_payments", metric: "amount" }, userId, "collections"));

add("receivables_report",
  "Current outstanding receivables by customer directly from Zoho Contacts. Includes active and inactive customers. Base mode uses recorded outstanding_receivable_amount_bcy, fetching contact details when needed; never guesses exchange rates. Does not subtract unused credits or reconstruct historical balances. Explicit organization scope required. Continue incomplete reports with continue_report; get_report section groups returns all customers ranked separately within each organization/currency, and evidence returns source amounts. Two complete reads verify IDs and report fields, with one bounded retry for changes.",
  { ...scopeArgs, currency_basis: z.enum(["base", "transaction"]).default("base"), customer_id: id.optional() },
  (args, userId) => report({ ...args, module: "contacts", metric: "outstanding_receivable_amount", group_by: "customer" }, userId, "receivables"));

add("list",
  "List one explicit organization's page, or build a validated source-field summary using summarize/group_by. A raw page is not a total. For collections use collections_report; for current customer outstanding balances use receivables_report. Source total is not recognized revenue; balance is current, not a historical cutoff balance. Summaries allow only typed local date/status filters and explicit metric; unsupported financial interpretations must use a finance-approved source report.",
  { ...moduleArg, ...scopeArgs, ...summaryArgs, module_api_name: id.optional(), summarize: z.boolean().optional(),
    page: z.coerce.number().int().min(1).default(1), per_page: z.coerce.number().int().min(1).max(200).default(100),
    entity: id.optional(),
    params: z.record(z.unknown()).refine(p => Object.keys(p).length === 0, "Arbitrary filters are not validated; use typed report dates/statuses").optional(),
  },
  async (args, userId) => {
    if (args.summarize || args.group_by || args.all_organizations || args.organization_ids || args.search_text || args.customer_id || args.vendor_id) {
      if (args.entity || args.module === "custom_fields") return fail("Custom field definitions require a raw list with entity; financial summaries are unsupported");
      return report(args, userId);
    }
    if (args.date_start || args.date_end || args.statuses) return fail("Use summarize:true for validated date/status filtering");
    const m = resolve(args, "list");
    if (!args.organization_id) return fail("Select an explicit organization_id; list_organizations shows available entities");
    await checkOrg(userId, args.organization_id);
    if (args.module === "custom_fields" && !args.entity) return fail("entity is required for custom_fields");
    const r = await zohoRequest(userId, { method: "GET", path: m.path, noOrg: m.noOrg,
      query: { organization_id: args.organization_id, page: args.page, per_page: args.per_page, ...(args.entity && { entity: args.entity }) } });
    if (!r.ok) return fail(r.text);
    const rows = extractRows(r.data, m.rowKey);
    return reply({ organization_id: args.organization_id, module: args.module, page: args.page,
      returned_record_count: rows.length, has_more_page: r.data.page_context?.has_more_page ?? null,
      figures_are_complete: false, note: "Raw page only; never calculate report totals from this page.",
      records: rows }, userId);
  });

add("continue_report", "Continue a stored report's remaining pages. Scope is fixed. Do not combine totals from successive calls; each response replaces the previous report summary.",
  { report_id: z.string().uuid() }, async ({ report_id }, userId) => {
    const stored = await db.getReport(report_id, userId);
    if (!stored || stored.payload.kind === "raw") return fail("Report not found or expired");
    selectOrganizations(await organizations(userId),{organization_ids:stored.payload.organizations.map(o=>o.id)});
    await db.enqueueReport(report_id,userId);
    const job=await db.claimReportJob(report_id,userId);
    if(job)await resumeReportJob(job);
    const latest=await db.getReport(report_id,userId);
    return reply({...calculate(latest.payload,resolve(latest.payload.spec,"list")).summary,background_job:await db.reportJobStatus(report_id,userId)},userId);
  });

add("report_definitions","Show the versioned calculation definitions, expected organization IDs, and which accounting interpretations remain unsupported. These definitions are not finance approval.",{},async()=>textResult({definitions:Object.values(DEFINITIONS),expected_organization_ids:expectedOrganizations(),finance_approval:"Requires operator-approved actual reference records"}));
add("historical_receivables_report","Read an operator-approved historical customer closing-balance export by reference ID, explicit entity scope and exact as_of date. Never substitutes current balances. An administrator must install the actual source export first; this tool cannot invent or approve references.",
  {...scopeArgs,reference_id:z.string().uuid(),as_of:date},async(args,userId)=>{
    const {reference_id,as_of}=args;
    const ref=await db.getReference(reference_id,userId);
    if(!ref || ref.spec.as_of!==as_of)return fail("No approved historical reference for this ID and cutoff date");
    const available=await organizations(userId);
    if(args.all_organizations)selectOrganizations(available,args);
    const scope=args.all_organizations?{organization_ids:expectedOrganizations()}:args;
    const selected=selectOrganizations(available,scope).map(o=>String(o.organization_id));
    if(fingerprint(selected.sort())!==fingerprint(ref.organizations.map(o=>o.organization_id).sort()))return fail("Historical reference scope differs from the requested entities");
    return reply(historicalResult(ref,reference_id),userId);
  });
add("connector_status","Check this account's current Zoho access, expected-entity coverage, background report jobs and recent operational outcomes. No other user's accounts or events are exposed.",{},async(_args,userId)=>{
  const available=await organizations(userId);
  return textResult({version:VERSION,build_id:BUILD_ID,zoho_access:"ok",coverage:entityCoverage(available,available.map(o=>String(o.organization_id))),...await db.operationalStatus(userId)});
});
add("finance_question","Run a supported plain-language question through a deterministic report planner. Supports gross collections with explicit dates/named month, current customer receivables, or an installed historical reference. Provide exact entity IDs; unsupported/ambiguous requests return clarification instead of guessing. This planner does not guarantee how an external ChatGPT client interprets a question before calling it.",
  {question:z.string().min(3).max(1000),organization_id:id.optional(),organization_ids:z.array(id).min(1).max(100).optional(),currency_basis:z.enum(["base","transaction"]).optional(),reference_id:z.string().uuid().optional()},
  async(args,userId)=>{
    const plan=planFinanceQuestion(args.question,args);
    if(plan.status!=="ready")return textResult(plan);
    if(plan.tool==="historical_receivables_report") {
      const ref=await db.getReference(args.reference_id,userId);
      if(!ref)return fail("Historical reference not found for this account");
      const requested=plan.arguments.all_organizations?expectedOrganizations():args.organization_ids||[args.organization_id];
      if(!requested.length||fingerprint([...requested].sort())!==fingerprint(ref.organizations.map(o=>o.organization_id).sort()))return fail("Historical reference scope differs from the requested entities");
      if(args.currency_basis&&args.currency_basis!==ref.spec.currency_basis)return fail("Historical reference uses a different currency basis");
      delete plan.arguments.currency_basis;
    }
    const tool=tools.find(t=>t.name==="ZohoBooks_"+plan.tool);
    const result=await tool.run(z.object(tool.schema).strict().parse(plan.arguments),userId);
    return { ...result,content:[{type:"text",text:JSON.stringify({report_plan:plan})},...result.content]};
  });
add("export_report","Create a five-minute download link for this account's report evidence. JSON includes summary and all audit sections; CSV exports a selected section with verification labels and spreadsheet-safe cells. Anyone holding the link can download until it expires, subject to current Zoho access. No export is sent to another person automatically.",
  {report_id:z.string().uuid(),format:z.enum(["json","csv"]).default("json"),section:z.enum(["evidence","groups","exclusions","validation_errors","reconciliation_differences"]).default("evidence")},async({report_id,format,section},userId)=>{
    const stored=await db.getReport(report_id,userId);
    if(!stored||stored.payload.kind==="raw")return fail("Financial report not found or expired");
    selectOrganizations(await organizations(userId),{organization_ids:stored.payload.organizations.map(o=>o.id)});
    const ticket=createDownloadTicket(report_id,userId,format,section);
    return textResult({download_url:process.env.PUBLIC_URL+"/reports/"+report_id+"/download?ticket="+encodeURIComponent(ticket),expires_in_seconds:300,report_retained_until:stored.expires_at});
  });

add("reconcile_report", "Compare every included monetary record with an actual user-supplied finance export/reference. Never invent reference rows. Checks IDs, organizations, currencies and exact amounts; a matching total alone is insufficient. Stores comparison results and reference provenance; does not certify the external reference itself.",
  { report_id: z.string().uuid(), reference_label: z.string().min(1).max(500),
    records: z.array(z.object({ organization_id: id, record_id: id, currency: z.string().regex(/^[A-Z]{3}$/), amount: z.string().regex(/^-?\d+(?:\.\d+)?$/) }).strict()).max(10000) },
  async ({ report_id, reference_label, records }, userId) => {
    const stored = await db.getReport(report_id, userId);
    if (!stored || stored.payload.kind === "raw") return fail("Report not found or expired");
    const snapshot = stored.payload;
    selectOrganizations(await organizations(userId), { organization_ids: snapshot.organizations.map(o => o.id) });
    const result = calculate(snapshot, resolve(snapshot.spec, "list"));
    if (!result.summary.figures_are_complete || snapshot.spec.metric === "count") return fail("Only complete, valid monetary reports can be reconciled");
    const comparison = reconcileEvidence(result.evidence, records);
    snapshot.reconciliation = { status: comparison.status, reference_label, reference_fingerprint: fingerprint(records),
      reference_count: records.length, difference_count: comparison.differences.length, compared_at: new Date().toISOString(), provenance: "User-supplied reference; not independently authenticated" };
    snapshot.reconciliation_differences = comparison.differences;
    await db.saveReport(report_id, userId, snapshot, stored.revision);
    return reply({ report_id, ...snapshot.reconciliation, differences: comparison.differences }, userId);
  });

add("get_report", "Read a stored report summary, every group, receipt evidence, exclusions, validation errors, or original source records. Retention defaults to 30 days; summary reports retained_until. Pages and text fragments preserve all stored data; use next_page/next_offset until absent. Stored reports are historical retrievals, not fresh Zoho reads.",
  { report_id: z.string().uuid(), section: z.enum(["summary", "evidence", "groups", "exclusions", "validation_errors", "source_records", "reconciliation_differences", "raw"]).default("summary"),
    page: z.coerce.number().int().min(1).default(1), per_page: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0) },
  async ({ report_id, section, page, per_page, offset }, userId) => {
    const stored = await db.getReport(report_id, userId);
    if (!stored) return fail("Report not found or expired");
    const snapshot = stored.payload;
    let value;
    if (snapshot.kind === "raw") value = snapshot.value;
    else {
      selectOrganizations(await organizations(userId), { organization_ids: snapshot.organizations.map(o => o.id) });
      const result = calculate(snapshot, resolve(snapshot.spec, "list"));
      value = section === "reconciliation_differences" ? snapshot.reconciliation_differences || [] : section === "summary" ? {...result.summary,retained_until:stored.expires_at,background_job:await db.reportJobStatus(report_id,userId)} : section === "source_records"
        ? snapshot.organizations.flatMap(o => o.rows.map(row => ({ organization_id: o.id, record: row })))
        : result[section];
      if (value === undefined) return fail("Invalid report section");
    }
    const total = Array.isArray(value) ? value.length : undefined;
    const selected = Array.isArray(value) ? value.slice((page - 1) * per_page, page * per_page) : value;
    const out = { report_id, section, page, total_records: total, data: selected,
      ...(total > page * per_page && { next_page: page + 1 }) };
    const serialized = JSON.stringify(out);
    if (serialized.length <= limit() && offset === 0) return textResult(out);
    const size = Math.floor((limit() - 1500) / 6); // Worst-case JSON string escaping.
    return textResult({ report_id, section, page, format: "JSON text fragment", total_characters: serialized.length,
      offset, fragment: serialized.slice(offset, offset + size),
      ...(offset + size < serialized.length ? { next_offset: offset + size } : { next_page: out.next_page }) });
  });

add("get", "Retrieve a record with explicit organization and ID. Financial amounts retain source currency semantics; this record alone is not a complete report.",
  { ...recordArgs, record_id: id },
  async (args, userId) => {
    const m = resolve(args, "get");
    await checkOrg(userId, args.organization_id);
    const r = await zohoRequest(userId, { method: "GET", path: m.path + "/" + encodeURIComponent(args.record_id),
      query: { organization_id: args.organization_id }, noOrg: m.noOrg });
    return r.ok ? reply({ organization_id: args.organization_id, module: args.module, source: r.data }, userId) : fail(r.text);
  });

add("describe_module", "Show module operations, expected fields and source-report limitations. Field hints are static; Zoho validates region-specific/custom fields. Writes always require a preview followed by confirm_write.",
  moduleArg, async ({ module }) => {
    const m = MODULES[module];
    return textResult({ module, operations: m.ops.filter(op => !READ_ONLY || ["get", "list"].includes(op)),
      fields: m.hint, note: m.listNote, id_field: m.idField, read_only: READ_ONLY });
  });

for (const operation of ["create", "update", "delete"]) {
  add(operation, `Prepare, but do not execute, a ${operation} operation. Requires a unique idempotency_key per intended action. Show the preview to the user; use confirm_write only after their explicit confirmation. Updates to line_items replace the list. The preview expires after 10 minutes.`,
    { ...recordArgs, ...(operation !== "create" && { record_id: id }),
      ...(operation !== "delete" && { data: z.record(z.unknown()) }), idempotency_key: z.string().uuid() },
    async (args, userId) => {
      const m = resolve(args, operation);
      validateWrite(args.module, operation, args.data);
      const org = await checkOrg(userId, args.organization_id);
      const path = m.path + (operation === "create" ? "" : "/" + encodeURIComponent(args.record_id));
      let current = null;
      if (operation !== "create") {
        const r = await zohoRequest(userId, { method: "GET", path, query: { organization_id: args.organization_id } });
        if (!r.ok) return fail("Cannot safely preview this operation: the current record could not be read");
        current = r.data;
      }
      const operationId = randomUUID();
      const payload = { operation, module: args.module, organization_id: args.organization_id, organization_name: org.name,
        record_id: args.record_id, path, data: args.data, before_hash: current ? recordFingerprint(current) : null,
        current, request_fingerprint: fingerprint({ operation, ...args }) };
      await db.saveWrite(operationId, userId, args.idempotency_key, payload);
      return reply({ operation_id: operationId, state: "preview", preview: payload,
        instruction: "Obtain user confirmation of this exact organization, target and changes before confirm_write." }, userId);
    }, true);
}
add("confirm_write", "Execute a previously reviewed write once. user_confirmed must reflect explicit user approval. Rechecks organization access and current record; rejects stale previews. An unknown outcome must be reconciled in Zoho, never blindly retried.",
  { operation_id: z.string().uuid(), user_confirmed: z.literal(true) },
  async ({ operation_id }, userId) => {
    const saved = await db.getWrite(operation_id, userId);
    if (!saved) return fail("Operation not found");
    if (saved.state !== "preview") return reply({ operation_id, state: saved.state, outcome: saved.payload.outcome }, userId);
    const p = saved.payload;
    await checkOrg(userId, p.organization_id);
    if (p.before_hash) {
      const r = await zohoRequest(userId, { method: "GET", path: p.path, query: { organization_id: p.organization_id } });
      if (!r.ok || recordFingerprint(r.data) !== p.before_hash) return fail("Record changed or could not be verified; prepare and review a new preview");
    }
    if (!await db.claimWrite(operation_id, userId)) return fail("Operation already claimed or expired; inspect its state");
    const r = await zohoRequest(userId, { method: { create: "POST", update: "PUT", delete: "DELETE" }[p.operation],
      path: p.path, query: { organization_id: p.organization_id }, body: p.data });
    const state = r.ok ? "completed" : "unknown";
    await db.finishWrite(operation_id, userId, state, { ...p, outcome: r.ok ? r.data : r.text });
    return reply({ operation_id, state, outcome: r.ok ? r.data : r.text }, userId);
  }, true);

add("list_organizations", "List accessible organizations and the saved preference. Every record/report/write still requires explicit organization scope.",
  {}, async (_args, userId) => {
    const list = await organizations(userId);
    const user = await db.getUser(userId);
    return reply({ preferred_organization_id: user?.default_org_id,
      organizations: list.map(o => ({ organization_id: String(o.organization_id), name: o.name, base_currency: o.currency_code })) }, userId);
  });
add("set_default_organization", "Save a convenience preference. Does not change the scope of any report, read, or write; those require explicit organization IDs.",
  { organization_id: id }, async ({ organization_id }, userId) => {
    await checkOrg(userId, organization_id);
    await db.setDefaultOrg(userId, organization_id);
    return textResult({ preferred_organization_id: organization_id });
  });
export default tools;
export { READ_ONLY, MODULE_NAMES };

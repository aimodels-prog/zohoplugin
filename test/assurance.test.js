import test from "node:test";
import assert from "node:assert/strict";
import { validateReference, referenceKey, compareReference, historicalResult } from "../finance-reference.js";
import { entityCoverage, expectedOrganizations, currentDate } from "../report-definitions.js";
import { planFinanceQuestion } from "../question-plan.js";
import { createDownloadTicket, verifyDownloadTicket, renderExport } from "../report-export.js";
import { reserveRequest, retryDelay } from "../request-pacing.js";
import { requestJson } from "../http.js";
import { createSnapshot, advanceSnapshot, calculate, selectOrganizations } from "../reporting.js";
import { MODULES } from "../modules.js";

// All values in this file are synthetic software tests, never production acceptance.
const organizations=[{organization_id:"om",name:"Synthetic Oman",currency_code:"OMR",time_zone:"Asia/Muscat"}];
const spec={kind:"collections",module:"customer_payments",metric:"amount",currency_basis:"base",date_start:"2026-08-01",date_end:"2026-08-31"};
const reference=()=>({schema_version:1,label:"Synthetic software test only",source:{type:"finance_export",report_name:"Test receipts",exported_at:"2026-09-01T00:00:00Z",sha256:"0".repeat(64)},approval:{approved_by:"Synthetic test actor",approved_at:"2026-09-01T00:00:01Z"},definition_id:"gross_collections_v1",spec:{...spec},organizations:structuredClone(organizations),records:[{organization_id:"om",record_id:"1",currency:"OMR",amount:"1.234"}]});
async function report() {
  const snapshot=createSnapshot(spec,organizations);
  await advanceSnapshot(snapshot,MODULES.customer_payments,async()=>({ok:true,data:{customer_payments:[{payment_id:"1",date:"2026-08-15",amount:"1.234",bcy_amount:"1.234",currency_code:"OMR"}],page_context:{has_more_page:false}}}));
  return {snapshot,result:calculate(snapshot,MODULES.customer_payments)};
}
test("reference comparison requires every identity and amount, not just a matching total",async()=>{
  const {snapshot,result}=await report();
  assert.equal(compareReference(snapshot,result,reference()).status,"matches_supplied_reference");
  const wrong=reference();wrong.records[0].record_id="different";
  assert.notEqual(compareReference(snapshot,result,wrong).status,"matches_supplied_reference");
  assert.throws(()=>compareReference(snapshot,{...result,summary:{figures_are_complete:false}},reference()),/complete/);
  for(const change of [{date_start:"2026-08-02"},{currency_basis:"transaction"},{group_by:"customer"}]) {
    const ref=reference();Object.assign(ref.spec,change);
    assert.throws(()=>compareReference(snapshot,result,ref),/do not match/);
  }
});
test("reference imports reject fabricated fixture approval, duplicates and inconsistent currencies",()=>{
  for(const mutate of [r=>r.source.type="synthetic_fixture",r=>r.records.push(r.records[0]),r=>r.organizations.push(r.organizations[0]),r=>r.records[0].organization_id="missing",r=>r.records[0].currency="EUR",r=>r.definition_id="current_receivables_v1",r=>r.approval.approved_at="2026-08-01T00:00:00Z",r=>r.source.exported_at="2099-01-01T00:00:00Z"]) {
    const ref=reference();mutate(ref);assert.throws(()=>validateReference(ref));
  }
});
test("scope keys ignore entity ordering but preserve report filters",()=>{
  const orgs=[...organizations,{organization_id:"ae"}];
  assert.equal(referenceKey(spec,orgs),referenceKey(spec,[...orgs].reverse()));
  assert.notEqual(referenceKey(spec,orgs),referenceKey({...spec,customer_id:"c"},orgs));
});
test("stale current receivables references cannot certify a fresh report",()=>{
  const ref=reference();ref.spec={kind:"receivables",module:"contacts",metric:"outstanding_receivable_amount",currency_basis:"base",group_by:"customer"};ref.definition_id="current_receivables_v1";
  const snapshot={spec:ref.spec,organizations,started_at:"2026-09-02T00:00:00Z"};
  assert.throws(()=>compareReference(snapshot,{summary:{figures_are_complete:true}},ref),/five minutes/);
});
test("historical exports preserve explicit cutoff and exact amounts without claiming live reconciliation",()=>{
  const ref=reference();ref.spec={kind:"historical_receivables",module:"contacts",metric:"closing_balance",currency_basis:"base",as_of:"2026-08-31",group_by:"customer"};ref.definition_id="historical_receivables_v1";
  const result=historicalResult(ref,"reference-id");
  assert.equal(result.totals[0].amount,"1.234");
  assert.equal(result.reconciliation_status,"imported_reference_not_independently_reconciled");
  ref.spec.as_of="2026-09-02";assert.throws(()=>validateReference(ref),/cutoff/);
});
test("five-entity coverage distinguishes missing access, omitted scope and missing configuration",()=>{
  const ids=["om","ae","sa","qa","bh"],available=ids.map(organization_id=>({organization_id}));
  assert.equal(entityCoverage(available,ids,ids).status,"all_expected_entities_covered");
  assert.deepEqual(entityCoverage(available.slice(1),ids,ids).missing_access_ids,["om"]);
  assert.deepEqual(entityCoverage(available,ids.slice(1),ids).omitted_ids,["om"]);
  assert.equal(entityCoverage(available,ids,[]).status,"expected_entities_not_configured");
  process.env.EXPECTED_ORGANIZATION_IDS="om,om";assert.throws(expectedOrganizations);delete process.env.EXPECTED_ORGANIZATION_IDS;
});
test("entity calendar dates honor timezone boundaries",()=>{
  const time=new Date("2026-08-31T21:00:00Z");
  assert.equal(currentDate("Asia/Muscat",time),"2026-09-01");
  assert.equal(currentDate("America/New_York",time),"2026-08-31");
});
test("duplicate or conflicting entity scopes cannot silently multiply or broaden a report",()=>{
  assert.throws(()=>selectOrganizations(organizations,{organization_ids:["om","om"]}),/Duplicate/);
  assert.throws(()=>selectOrganizations([...organizations,...organizations],{organization_id:"om"}),/duplicated/);
  assert.throws(()=>selectOrganizations(organizations,{organization_id:"om",all_organizations:true}),/exactly one/);
  assert.equal(planFinanceQuestion("Outstanding for all five entities",{organization_ids:["om"]}).status,"needs_clarification");
});
test("plain-language plans route collections, current balances and historical requests explicitly",()=>{
  const p=planFinanceQuestion("collections for August 2026",{organization_id:"om"});
  assert.equal(p.tool,"collections_report");assert.equal(p.arguments.date_end,"2026-08-31");
  assert.equal(planFinanceQuestion("Outstanding receivables by customer for all five entities").arguments.all_organizations,true);
  assert.equal(planFinanceQuestion("Outstanding as of 2026-08-31",{organization_id:"om",reference_id:"r"}).tool,"historical_receivables_report");
  for(const q of ["net collections for August 2026","outstanding as of 2026-08-31","collections last month","convert outstanding to USD","collections 2026-08-31 to 2026-08-01","collections 2026-02-30 to 2026-03-01","outstanding for customer named ABC"])assert.equal(planFinanceQuestion(q,{organization_id:"om"}).status,"needs_clarification",q);
});
test("download tickets expire, reject tampering and bind the requested report",()=>{
  process.env.TOKEN_ENCRYPTION_KEY="12".repeat(32);
  const ticket=createDownloadTicket("report","owner","csv","evidence",1000);
  assert.equal(verifyDownloadTicket(ticket,"report",1001).userId,"owner");
  assert.throws(()=>verifyDownloadTicket(ticket,"other",1001));
  assert.throws(()=>verifyDownloadTicket(ticket,"report",301000));
  assert.throws(()=>verifyDownloadTicket(ticket+"x","report",1001));
  assert.throws(()=>createDownloadTicket("report","owner","exe","evidence"));
});
test("CSV neutralizes formulas and preserves opaque IDs plus incomplete status",()=>{
  const result={summary:{report_id:"r",figures_are_complete:false,reconciliation_status:"not_reconciled"},evidence:[{record_id:"9007199254740993123",customer_name:" =HYPERLINK(x)",included_amount:"-1.234"}]};
  const csv=renderExport(result,"csv","evidence");
  assert.ok(csv.includes("'9007199254740993123"));assert.ok(csv.includes("' =HYPERLINK(x)"));assert.ok(csv.includes('"-1.234"'));assert.ok(csv.includes('"false"'));
  assert.equal(JSON.parse(renderExport(result,"json","evidence")).summary.figures_are_complete,false);
});
test("request pacing separates organizations and preserves server retry delays",async()=>{
  assert.equal(reserveRequest("test-om",1000,700),0);assert.equal(reserveRequest("test-om",1000,700),700);assert.equal(reserveRequest("test-ae",1000,700),0);
  assert.equal(retryDelay("120"),120000);assert.equal(retryDelay("Tue, 15 Sep 2026 00:02:00 GMT",Date.parse("2026-09-15T00:00:00Z")),120000);
  let calls=0;
  const r=await requestJson("https://example.test",{},async()=>{calls++;return new Response("{}",{status:429,headers:{"Retry-After":"120"}});});
  assert.equal(calls,1);assert.equal(r.retryAfterMs,120000);assert.equal(r.httpOk,false);
});

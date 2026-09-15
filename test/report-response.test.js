import test from 'node:test';
import assert from 'node:assert/strict';
import { reportResponse } from '../report-response.js';
const summary={report_id:'r',specification:{module:'contacts',metric:'outstanding_receivable_amount',group_by:'customer'},organizations:[{organization_id:'om'}]};
test('processing response mandates automatic same-report continuation and contains no partial ranking',()=>{
  const r=reportResponse({summary:{...summary,figures_are_complete:false,continuation_available:true,totals:null},groups:[]});
  assert.equal(r.status,'processing');assert.equal(r.groups,undefined);assert.equal(r.totals,null);
  assert.deepEqual(r.next_action.arguments,{report_id:'r'});assert.equal(r.next_action.tool,'ZohoBooks_continue_report');
});
test('complete ranking exposes 50 verified groups and points to the next stored page',()=>{
  const groups=Array.from({length:61},(_,i)=>({group_id:String(i),rank_in_organization_currency:i+1}));
  const r=reportResponse({summary:{...summary,figures_are_complete:true,continuation_available:false},groups});
  assert.equal(r.groups.length,50);assert.equal(r.groups_complete,false);assert.equal(r.next_action.arguments.page,2);assert.equal(r.next_action.arguments.per_page,50);
});
test('validation failure does not invite an endless continuation or present empty ranking as zero',()=>{
  const r=reportResponse({summary:{...summary,figures_are_complete:false,continuation_available:false},groups:[]});
  assert.equal(r.status,'failed_validation');assert.equal(r.next_action,null);assert.equal(r.groups,undefined);
});
test('explicit count reports cannot be mistaken for customer receivables',()=>{
  const r=reportResponse({summary:{...summary,specification:{module:'invoices',metric:'count'},figures_are_complete:true},groups:[]});
  assert.equal(r.amounts_calculated,false);assert.equal(r.tool_for_customer_receivables.tool,'ZohoBooks_receivables_report');
  assert.deepEqual(r.tool_for_customer_receivables.arguments.organization_ids,['om']);
});

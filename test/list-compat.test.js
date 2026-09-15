import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeListArgs,compatibleListResult,legacyAction} from '../list-compat.js';
test('legacy params preserve explicit financial intent without broadening source scope',()=>{
  const args=normalizeListArgs({module:'invoices',organization_id:'om',params:{metric:'balance',currency_basis:'base',group_by:'customer'}});
  assert.equal(args.metric,'balance');assert.equal(args.currency_basis,'base');assert.equal(args.organization_id,'om');
  assert.throws(()=>normalizeListArgs({module:'invoices',metric:'count',params:{metric:'balance'}}),/Conflicting/);
  for(const params of [{organization_id:'other'},{all_organizations:true},{filter_by:'Status.Unpaid'},{metric:'anything'},{currency_basis:'base',unrecognized:true}])assert.throws(()=>normalizeListArgs({module:'invoices',params}));
});
test('continuation uses saved scope and rejects changed criteria or invalid identifiers',()=>{
  for(const params of [{report_id:'invalid'},{section:'groups'},{offset:1},{report_id:'123e4567-e89b-42d3-a456-426614174000',metric:'balance'}])assert.throws(()=>normalizeListArgs({module:'invoices',params}));
});
test('legacy callers receive only existing-list actions for continuation and result pagination',()=>{
  for(const action of [{tool:'ZohoBooks_continue_report',arguments:{report_id:'r'}},{tool:'ZohoBooks_get_report',arguments:{report_id:'r',section:'groups',page:2,per_page:50}}]) {
    const result={content:[{type:'text',text:JSON.stringify({next_action:action})}]};
    const v=JSON.parse(compatibleListResult(result,{module:'invoices'}).content[0].text);
    assert.equal(v.next_action.tool,'ZohoBooks_list');assert.equal(v.next_action.arguments.params.report_id,'r');
  }
  assert.deepEqual(legacyAction('ZohoBooks_receivables_report',{organization_ids:['om'],currency_basis:'base'},'invoices').arguments,{module:'contacts',organization_ids:['om'],params:{report_type:'receivables',currency_basis:'base'}});
});
test('oversized responses and fragments remain retrievable without newly published tools',()=>{
  const r=v=>JSON.parse(compatibleListResult({content:[{type:'text',text:JSON.stringify(v)}]},{module:'invoices',per_page:200}).content[0].text);
  assert.equal(r({response_stored:true,report_id:'r'}).next_action.arguments.params.section,'raw');
  const next=r({format:'JSON text fragment',report_id:'r',section:'groups',page:2,next_offset:100}).next_action;
  assert.equal(next.tool,'ZohoBooks_list');assert.equal(next.arguments.params.offset,100);assert.equal(next.arguments.per_page,200);
});

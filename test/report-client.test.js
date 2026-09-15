import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyReportClient } from '../report-client.js';

const args={module:'contacts',organization_id:'om',params:{report_type:'receivables'}};
const group=(id,amount)=>({group_id:id,organization_id:'om',currency:'OMR',amount:{exact:amount}});
const complete=groups=>({report_id:'r',status:'complete',figures_are_complete:true,record_count:groups.length,group_count:groups.length,validation_error_count:0,organizations:[{organization_id:'om',second_pass_verified:true,errors:[]}],groups,totals:[{organization_id:'om',currency:'OMR',amount:{exact:'3'}}],next_action:null});
const result=value=>({isError:false,content:[{type:'text',text:JSON.stringify(value)}]});

test('release acceptance rejects missing groups, duplicate customers, incorrect ranking and mismatched totals',async()=>{
  const good=complete([group('a','2'),group('b','1')]);
  assert.equal((await legacyReportClient(async()=>result(good)).run(args)).groups_read,2);
  for(const invalid of [
    {...good,group_count:3},
    complete([group('a','2'),group('a','1')]),
    complete([group('b','1'),group('a','2')]),
    {...good,totals:[{organization_id:'om',currency:'OMR',amount:{exact:'3.001'}}]},
    {...good,figures_are_complete:false},
  ])await assert.rejects(legacyReportClient(async()=>result(invalid)).run(args));
});

test('release acceptance refuses a new continuation tool and a changed report ID',async()=>{
  const pending={report_id:'r',status:'processing',next_action:{tool:'ZohoBooks_continue_report',arguments:{report_id:'r'}}};
  await assert.rejects(legacyReportClient(async()=>result(pending)).run(args),/unavailable tool/);
  pending.next_action={tool:'ZohoBooks_list',arguments:{module:'contacts',params:{report_id:'r'}}};
  let calls=0;
  await assert.rejects(legacyReportClient(async()=>result(calls++?{...complete([group('a','3')]),report_id:'replacement'}:pending)).run(args),/replacement report/);
});

test('release acceptance rejects truncated and overlapping response fragments',async()=>{
  const fragment={report_id:'r',section:'groups',page:1,format:'JSON text fragment',total_characters:10,offset:0,fragment:'123'};
  await assert.rejects(legacyReportClient(async()=>result(fragment)).run(args),/Missing report fragment/);
  fragment.next_offset=2;
  await assert.rejects(legacyReportClient(async()=>result(fragment)).run(args),/skipped or repeated/);
});

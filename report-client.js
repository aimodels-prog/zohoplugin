import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { money } from './reporting.js';

// The original reporting contract: no new tools or top-level metric fields.
const oldInputs=z.object({module:z.enum(['invoices','contacts','customer_payments']),organization_id:z.string().optional(),organization_ids:z.array(z.string()).optional(),all_organizations:z.boolean().optional(),summarize:z.boolean().optional(),group_by:z.enum(['customer','vendor','month','status','currency','aging']).optional(),page:z.number().int().min(1).optional(),per_page:z.number().int().min(1).max(200).optional(),params:z.record(z.unknown()).optional()}).strict();
const check=(condition,message)=>{if(!condition)throw new Error(message);};

export function legacyReportClient(request,{timeoutMs=180000,maxCalls=400}={}) {
  let calls=0,deadline;
  async function call(action) {
    check(Date.now()<deadline && calls++<maxCalls,'Report acceptance exceeded its bounded request/time limit');
    check(action?.tool==='ZohoBooks_list','Report instructed an older client to use an unavailable tool');
    const args=oldInputs.parse(action.arguments);
    const result=await request({name:action.tool,arguments:args});
    check(!result.isError,'MCP tool failed during report acceptance');
    const block=result.content?.find(c=>c.type==='text');
    check(block,'Missing report response');
    return JSON.parse(block.text);
  }
  async function read(action) {
    let value=await call(action);
    if(value.format==='JSON text fragment') {
      const {report_id,section,page,total_characters}=value;
      check(Number.isSafeInteger(total_characters)&&total_characters>0&&total_characters<=20000000,'Invalid fragment size');
      let text='';
      while(true) {
        check(value.format==='JSON text fragment'&&value.report_id===report_id&&value.section===section&&value.page===page&&value.total_characters===total_characters&&value.offset===text.length&&typeof value.fragment==='string'&&value.fragment.length>0,'Report fragments changed identity, size or position');
        text+=value.fragment;
        check(text.length<=total_characters,'Report fragment exceeded declared size');
        if(value.next_offset===undefined) {check(text.length===total_characters,'Missing report fragment');break;}
        check(value.next_offset===text.length,'Report fragment skipped or repeated data');
        value=await call(value.next_action);
      }
      value=JSON.parse(text);
    }
    return value;
  }
  return { async run(args) {
    calls=0;deadline=Date.now()+timeoutMs;
    let result=await read({tool:'ZohoBooks_list',arguments:args});
    // A stored oversized response has its own pointer ID. The report ID inside
    // the reassembled response remains the only continuation identity.
    if(result.response_stored) {
      const stored=await read(result.next_action);
      check(stored.section==='raw'&&stored.data&&typeof stored.data==='object','Invalid stored response');
      result=stored.data;
    }
    const reportId=result.report_id;
    check(typeof reportId==='string','Missing report ID');
    while(result.status==='processing') {
      const retry=Date.parse(result.background_job?.run_after)-Date.now();
      if(retry>0)await delay(Math.min(retry,Math.max(0,deadline-Date.now())));
      result=await read(result.next_action);
      if(result.response_stored)result=(await read(result.next_action)).data;
      check(result.report_id===reportId,'Continuation started a replacement report');
    }
    check(result.status==='complete'&&result.figures_are_complete===true,'Report did not pass retrieval and value verification');
    check(result.organizations?.length>0&&result.organizations.every(o=>o.second_pass_verified&&!o.errors?.length),'Entity verification incomplete');
    const groups=[...(result.groups||[])];let next=result.next_action;
    while(next) {
      const page=await read(next);
      check(page.report_id===reportId&&page.section==='groups'&&page.figures_are_complete===true&&Array.isArray(page.data),'Invalid or unverified customer page');
      groups.push(...page.data);next=page.next_action;
    }
    check(groups.length===result.group_count,'Customer groups were omitted or duplicated');
    const seen=new Set(),sums=new Map(),previous=new Map();
    for(const group of groups) {
      const bucket=JSON.stringify([group.organization_id,group.currency]);
      const id=JSON.stringify([group.organization_id,group.currency,group.group_id]);
      check(!seen.has(id),'Duplicate customer/currency group');seen.add(id);
      const amount=money(group.amount.exact);
      check(!previous.has(bucket)||previous.get(bucket).gte(amount),'Customer ranking is not descending within its entity/currency');
      previous.set(bucket,amount);sums.set(bucket,(sums.get(bucket)||money('0')).plus(amount));
    }
    for(const total of result.totals) {
      const bucket=JSON.stringify([total.organization_id,total.currency]);
      check(sums.has(bucket)&&sums.get(bucket).eq(money(total.amount.exact)),'Customer amounts do not add up to the report total');sums.delete(bucket);
    }
    check(!sums.size,'Customer group belongs to an unexpected entity/currency');
    return {report_id:reportId,calls,record_count:result.record_count,groups_read:groups.length,validation_errors:result.validation_error_count,
      entities:result.organizations.map(o=>({id:o.organization_id,records:o.fetched_records,pages:o.pages,verified:o.second_pass_verified})),
      client_tool_used:'ZohoBooks_list',reconciliation_status:result.reconciliation_status};
  } };
}

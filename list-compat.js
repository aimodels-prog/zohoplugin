import { z } from 'zod';
import { validDate, fingerprint } from './reporting.js';

const id=z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const date=z.string().refine(validDate,'Use a valid YYYY-MM-DD date');
export const listParamsSchema=z.object({
  metric:z.enum(['count','amount','total','balance']).optional(),
  currency_basis:z.enum(['transaction','base']).optional(),
  date_start:date.optional(),date_end:date.optional(),as_of:date.optional(),
  statuses:z.array(z.string().min(1)).min(1).optional(),
  customer_id:id.optional(),vendor_id:id.optional(),
  search_text:z.string().min(1).max(200).optional(),
  group_by:z.enum(['customer','vendor','month','status','currency','aging']).optional(),
  summarize:z.boolean().optional(),
  report_type:z.enum(['receivables','collections','source_field']).optional(),
  report_id:z.string().uuid().optional(),
  section:z.enum(['summary','groups','evidence','exclusions','validation_errors','source_records','reconciliation_differences','raw']).optional(),
  offset:z.number().int().min(0).optional(),
}).strict();

export function normalizeListArgs(input) {
  const {params,...args}=input;
  const options=listParamsSchema.parse(params||{});
  for(const [key,value] of Object.entries(options)) {
    if(args[key]!==undefined && fingerprint(args[key])!==fingerprint(value))throw new Error('Conflicting top-level and params value for '+key);
    args[key]=value;
  }
  if((args.section!==undefined||args.offset!==undefined)&&!args.report_id)throw new Error('params.section and params.offset require params.report_id');
  if(args.report_id && (args.report_type||Object.keys(options).some(k=>!['report_id','section','offset'].includes(k))))throw new Error('A saved report has fixed criteria; pass only report_id, section and offset in params');
  return args;
}

export function legacyAction(tool,args,module) {
  if(tool==='ZohoBooks_continue_report')return {tool:'ZohoBooks_list',arguments:{module,params:{report_id:args.report_id}}};
  if(tool==='ZohoBooks_get_report')return {tool:'ZohoBooks_list',arguments:{module,
    ...(args.page!==undefined&&{page:args.page}),...(args.per_page!==undefined&&{per_page:args.per_page}),
    params:{report_id:args.report_id,section:args.section||'summary',...(args.offset!==undefined&&{offset:args.offset})}}};
  if(tool==='ZohoBooks_receivables_report')return {tool:'ZohoBooks_list',arguments:{module:'contacts',
    ...(args.organization_id&&{organization_id:args.organization_id}),...(args.organization_ids&&{organization_ids:args.organization_ids}),...(args.all_organizations&&{all_organizations:true}),
    params:{report_type:'receivables',currency_basis:args.currency_basis||'base',...(args.customer_id&&{customer_id:args.customer_id})}}};
  return null;
}

// Rewrite only authored control fields, never source record text or instructions.
export function compatibleListResult(result,args) {
  return {...result,content:result.content.map(block=>{
    if(block.type!=='text')return block;
    let value;try{value=JSON.parse(block.text);}catch{return block;}
    if(!value||typeof value!=='object'||Array.isArray(value))return block;
    const rewrite=value=>{
      for(const key of ['next_action','tool_for_customer_receivables']) {
        const action=value?.[key];if(!action?.tool)continue;
        const mapped=legacyAction(action.tool,action.arguments,args.module);
        if(mapped)value[key]={...action,...mapped};
      }
    };
    rewrite(value);if(value.section==='summary')rewrite(value.data);
    if(value.response_stored) {
      value.next_action=legacyAction('ZohoBooks_get_report',{report_id:value.report_id,section:'raw'},args.module);
      value.instruction='Use the existing ZohoBooks_list tool with next_action.arguments to read the saved response. No new tool discovery is required.';
    }
    if(value.format==='JSON text fragment') {
      const next=value.next_offset!==undefined?{page:value.page,offset:value.next_offset}:value.next_page?{page:value.next_page}:null;
      value.next_action=next?legacyAction('ZohoBooks_get_report',{report_id:value.report_id,section:value.section,per_page:args.per_page||100,...next},args.module):null;
    } else if(value.next_page && value.section) {
      value.next_action=legacyAction('ZohoBooks_get_report',{report_id:value.report_id,section:value.section,page:value.next_page,per_page:args.per_page||100},args.module);
    }
    return {...block,text:JSON.stringify(value)};
  })};
}

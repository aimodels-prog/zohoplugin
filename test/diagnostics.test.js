import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { inputFailure, resultOutcome, monitorReasons } from '../diagnostics.js';

test('schema diagnostics identify failures without echoing sensitive inputs or unknown keys',()=>{
  const tool={name:'ZohoBooks_list',schema:{module:z.enum(['invoices']),params:z.object({metric:z.enum(['balance'])}).strict().optional()}};
  const parsed=z.object(tool.schema).strict().safeParse({module:'private-customer-name',secret_token:'private-token',params:{metric:'secret-amount'}});
  const failed=inputFailure(tool,parsed);
  assert.equal(failed.result.isError,true);assert.equal(failed.info.code,'schema_error');
  const serialized=JSON.stringify(failed);
  for(const secret of ['private-customer-name','private-token','secret-amount','secret_token'])assert.equal(serialized.includes(secret),false);
  assert.ok(serialized.includes('supported_report_options'));
});

test('verification failure is an operational failure even when the report is a successful tool response',()=>{
  const result=value=>({isError:false,content:[{type:'text',text:JSON.stringify(value)}]});
  assert.equal(resultOutcome(result({status:'failed_validation',report_id:'r'})).outcome,'verification_failed');
  assert.equal(resultOutcome(result({section:'summary',report_id:'r',data:{status:'failed_validation'}})).outcome,'verification_failed');
  for(const value of [{status:'processing'},{status:'complete'},{records:[{status:'failed_validation'}]}])assert.equal(resultOutcome(result(value)).outcome,'ok');
});

test('monitor flags recent client failures independently of background job health',()=>{
  const account={zoho_access:'ok',coverage:'all_expected_entities_covered',jobs:[],events_last_24_hours:[]};
  assert.deepEqual(monitorReasons(account),[]);
  for(const outcome of ['schema_error','unknown_tool','verification_failed','error','concurrency_limited'])assert.ok(monitorReasons({...account,events_last_24_hours:[{outcome,count:1}]}).includes('recent_connector_failures'));
});

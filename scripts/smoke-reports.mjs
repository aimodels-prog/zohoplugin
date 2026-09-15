import { randomBytes } from 'node:crypto';
import * as db from '../db.js';
import { legacyReportClient } from '../report-client.js';
import { VERSION, BUILD_ID } from '../security.js';

const [userId,organizationId]=process.argv.slice(2);
if(!userId||!organizationId)throw new Error('Supply the existing acceptance account ID and invoice organization ID');
const token=randomBytes(32).toString('hex');let counter=0;
try {
  if(!await db.getUser(userId))throw new Error('Acceptance account is not linked');
  await db.saveToken({token,kind:'access',clientId:'release-report-acceptance',userId,scopes:['zoho_books'],resource:process.env.PUBLIC_URL+'/mcp',ttlMs:600000});
  const request=async(method,params)=>{
    const response=await fetch(process.env.PUBLIC_URL+'/mcp',{method:'POST',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:++counter,method,params})});
    const body=await response.json();if(!response.ok||body.error)throw new Error('Public MCP request failed');return body.result;
  };
  const discovery=await request('tools/list',{});
  const list=discovery.tools?.find(t=>t.name==='ZohoBooks_list');
  if(!list?.inputSchema?.properties?.params?.properties?.metric?.enum?.includes('balance'))throw new Error('Live nested reporting schema does not match this release');
  const client=legacyReportClient(params=>request('tools/call',params));
  const invoices=await client.run({module:'invoices',organization_id:organizationId,group_by:'customer',params:{metric:'balance',currency_basis:'transaction'}});
  const receivables=await client.run({module:'contacts',all_organizations:true,params:{report_type:'receivables',currency_basis:'base'}});
  console.log(JSON.stringify({status:'passed',version:VERSION,build_id:BUILD_ID,checks:{invoice_balances:invoices,five_entity_receivables:receivables},finance_acceptance:'Requires independently approved finance references; this checks API retrieval and report delivery'}));
} catch(error) {
  console.error(JSON.stringify({status:'failed',version:VERSION,build_id:BUILD_ID,reason:error.name==='Error'&&!error.code?error.message:'Release report check could not finish'}));process.exitCode=1;
} finally {await db.deleteToken(token);await db.close();}

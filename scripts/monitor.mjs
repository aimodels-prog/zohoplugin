import * as db from "../db.js";
import { zohoRequest } from "../zoho.js";
import { expectedOrganizations,entityCoverage } from "../report-definitions.js";
import { BUILD_ID,VERSION } from "../security.js";
const results=[];
try {
  await db.health();
  for(const user of await db.listUsers()) {
    const r=await zohoRequest(user.id,{method:"GET",path:"/organizations",noOrg:true});
    const status=await db.operationalStatus(user.id);
    results.push({account_id:user.id,zoho_access:r.ok?"ok":"failed",coverage:r.ok?entityCoverage(r.data.organizations,r.data.organizations.map(o=>String(o.organization_id))).status:"unavailable",...status});
  }
  const attention=!expectedOrganizations().length||results.some(r=>r.zoho_access!=="ok"||r.coverage!=="all_expected_entities_covered"||r.jobs.some(j=>j.state==="failed"));
  console.log(JSON.stringify({category:"connector_monitor",status:attention?"attention_required":"ok",version:VERSION,build_id:BUILD_ID,accounts:results}));
  if(attention)process.exitCode=1;
} catch {console.error(JSON.stringify({category:"connector_monitor",status:"failed"}));process.exitCode=1;} finally {await db.close();}

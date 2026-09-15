// Operator-only import. There is deliberately no MCP tool that can approve references.
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { validateReference, referenceKey } from "../finance-reference.js";
import * as db from "../db.js";
import { zohoRequest } from "../zoho.js";
const [command,userId,referenceFile,sourceFile]=process.argv.slice(2);
try {
  if(command!=="import" || !userId || !referenceFile || !sourceFile) throw new Error("Usage: node scripts/finance-admin.mjs import USER_ID REFERENCE.json ORIGINAL_EXPORT.csv");
  const ref=validateReference(JSON.parse(await fs.readFile(referenceFile,"utf8")));
  const hash=createHash("sha256").update(await fs.readFile(sourceFile)).digest("hex");
  if(hash!==ref.source.sha256) throw new Error("Original export checksum does not match the reference manifest");
  const r=await zohoRequest(userId,{method:"GET",path:"/organizations",noOrg:true});
  if(!r.ok || ref.organizations.some(o=>!r.data.organizations?.some(a=>String(a.organization_id)===o.organization_id))) throw new Error("Reference includes an organization unavailable to the target account");
  const referenceId=randomUUID();
  await db.saveReference(referenceId,userId,referenceKey(ref.spec,ref.organizations),ref);
  console.log(JSON.stringify({reference_id:referenceId,status:"operator_approved_reference_installed",record_count:ref.records.length}));
} catch(error) {console.error(error.message);process.exitCode=1;} finally {await db.close();}

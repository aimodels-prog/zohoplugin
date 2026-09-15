import fs from "node:fs/promises";
import path from "node:path";
import { validateReference, compareReference } from "../finance-reference.js";
import { createSnapshot, advanceSnapshot, calculate } from "../reporting.js";
import { MODULES } from "../modules.js";
const directory=process.env.FINANCE_FIXTURE_DIR;
if(!directory) {
  console.log(JSON.stringify({status:"finance_validation_pending",reason:"No finance-approved fixtures supplied; synthetic tests do not constitute finance acceptance"}));
  if(process.env.REQUIRE_FINANCE_FIXTURES==="true")process.exitCode=1;
} else {
  const files=(await fs.readdir(directory)).filter(f=>f.endsWith(".json"));
  if(!files.length)throw new Error("Configured finance fixture directory contains no fixtures");
  let passed=0;
  for(const file of files) {
    const fixture=JSON.parse(await fs.readFile(path.join(directory,file),"utf8"));
    const reference=validateReference(fixture.reference);
    const s=createSnapshot(reference.spec,reference.organizations),m=MODULES[reference.spec.module];
    if(!m)throw new Error("Unsupported fixture module");
    // Captured API rows and separately approved reference rows must both be supplied.
    if(!Array.isArray(fixture.source_records))throw new Error("Missing captured API source records");
    const read=async req=>{
      const rows=fixture.source_records.filter(r=>r.organization_id===req.query.organization_id).map(r=>r.record);
      if(req.path!==m.path)throw new Error("Fixture must include recorded base fields needed for this calculation");
      return {ok:true,data:{[m.rowKey]:rows.slice((req.query.page-1)*200,req.query.page*200),page_context:{has_more_page:req.query.page*200<rows.length}}};
    };
    for(let n=0;n<1000&&s.organizations.some(o=>!o.verified&&!o.blocked);n++)await advanceSnapshot(s,m,read);
    s.started_at=reference.source.exported_at; // Replay the captured dataset's clock, not today's live balances.
    const comparison=compareReference(s,calculate(s,m),reference,Date.parse(reference.source.exported_at));
    if(comparison.status!=="matches_supplied_reference")throw new Error("Finance regression failed: "+file);
    passed++;
  }
  console.log(JSON.stringify({status:"matches_operator_approved_fixtures",fixtures:passed}));
}

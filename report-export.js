import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { validateEncryptionKey } from "./security.js";
const formats=new Set(["json","csv"]),sections=new Set(["evidence","groups","exclusions","validation_errors","reconciliation_differences"]);
function signature(text) {validateEncryptionKey();return createHmac("sha256",Buffer.from(process.env.TOKEN_ENCRYPTION_KEY,"hex")).update("report-download-v1:"+text).digest("base64url");}
export function createDownloadTicket(reportId,userId,format,section,now=Date.now()) {
  if(!formats.has(format)||!sections.has(section))throw new Error("Unsupported export format or section");
  const payload=Buffer.from(JSON.stringify({reportId,userId,format,section,expiresAt:now+300000,nonce:randomUUID()})).toString("base64url");
  return payload+"."+signature(payload);
}
export function verifyDownloadTicket(ticket,reportId,now=Date.now()) {
  if(typeof ticket!=="string"||ticket.length>2048)throw new Error("Invalid download ticket");
  const [payload,mac,...extra]=ticket.split(".");
  const expected=Buffer.from(signature(payload||"")),actual=Buffer.from(mac||"");
  if(extra.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error("Invalid download ticket");
  const claims=JSON.parse(Buffer.from(payload,"base64url").toString());
  if(claims.reportId!==reportId||!claims.userId||!Number.isFinite(claims.expiresAt)||claims.expiresAt<=now||claims.expiresAt>now+300000||!formats.has(claims.format)||!sections.has(claims.section))throw new Error("Expired or invalid download ticket");
  return claims;
}
function cell(value,field) {
  let text=value==null?"":typeof value==="object"?JSON.stringify(value):String(value);
  const numeric=["included_amount","original_amount","recorded_base_amount"].includes(field)&&/^-?\d+(\.\d+)?$/.test(text);
  // Escape spreadsheet formulas, and preserve opaque numeric IDs as text.
  if((!numeric&&/^[\s]*[=+@-]/.test(text))||field.endsWith("_id"))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
export function renderExport(result,format,section) {
  if(format==="json")return JSON.stringify({...result,exported_at:new Date().toISOString()},null,2);
  const source=section==="reconciliation_differences"?result.reconciliation_differences||[]:result[section];
  if(!Array.isArray(source))throw new Error("Unsupported export section");
  const rows=source.map(row=>({report_id:result.summary.report_id,figures_are_complete:result.summary.figures_are_complete,reconciliation_status:result.summary.reconciliation_status,...row}));
  const fields=[...new Set(["report_id","figures_are_complete","reconciliation_status",...rows.flatMap(Object.keys)])];
  return [fields.map(f=>cell(f,"header")).join(","),...rows.map(row=>fields.map(f=>cell(row[f],f)).join(","))].join("\r\n");
}

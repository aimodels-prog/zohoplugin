import { validDate } from "./reporting.js";
// This intentionally covers a small, explicit vocabulary. It is not a general LLM
// and does not silently interpret customer names, netting, relative dates or FX.
export function planFinanceQuestion(question, context={}) {
  const q=question.toLowerCase(), needs=[];
  if(/\b(net|revenue|profit|consolidat\w*|eliminat\w*|convert|exchange rate|payable\w*|overdue|aging|refunds?|withholding|fees|excluding|except|above|below|greater|less|top)\b/.test(q))return {status:"needs_clarification",reasons:["Requested accounting interpretation or filtering is outside the documented receipts/customer-balance definitions"]};
  const collection=/\b(collections?|receipts?)\b|payments? received/.test(q);
  const receivable=/\b(receivables?|outstanding|owed)\b|customer balances?/.test(q);
  if(collection===receivable)return {status:"needs_clarification",reasons:["Specify gross receipts or customer outstanding receivables"]};
  const args={currency_basis:context.currency_basis||"base"};
  const all=/\ball\b.*\b(entit\w*|compan\w*|organizations?)\b/.test(q);
  if(all && (context.organization_id||context.organization_ids))needs.push("Question requests all entities but an explicit entity scope was also supplied");
  if(context.organization_id&&context.organization_ids)needs.push("Supply exactly one explicit entity scope");
  if(all)args.all_organizations=true;
  else if(context.organization_id)args.organization_id=context.organization_id;
  else if(context.organization_ids?.length)args.organization_ids=context.organization_ids;
  else needs.push("An explicit organization scope is required");
  if(/\b(usd|eur|omr|aed|sar|gbp)\b/.test(q)&&!context.currency_basis)needs.push("Specify transaction or organization base currency; currencies are never implicitly converted");
  const dates=question.match(/\b\d{4}-\d{2}-\d{2}\b/g)||[];
  if(dates.some(d=>!validDate(d)))needs.push("Invalid calendar date");
  let tool;
  if(collection) {
    tool="collections_report";
    if(dates.length===2) {args.date_start=dates[0];args.date_end=dates[1];}
    else {
      const months=["january","february","march","april","may","june","july","august","september","october","november","december"];
      const match=q.match(new RegExp("\\b("+months.join("|")+") (20\\d{2})\\b"));
      if(match&&dates.length===0) {
        const month=months.indexOf(match[1])+1,year=Number(match[2]);
        args.date_start=`${year}-${String(month).padStart(2,"0")}-01`;
        args.date_end=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
      } else needs.push("Provide an inclusive ISO date range or a named month and year");
    }
    if(args.date_start>args.date_end)needs.push("Date range is reversed");
    if(/\b(customer|client)\b/.test(q))args.group_by="customer";
  } else if(/as of|month.end|closing|historical/.test(q)||dates.length) {
    tool="historical_receivables_report";
    if(dates.length!==1)needs.push("Provide exactly one ISO cutoff date");
    if(!context.reference_id)needs.push("An installed operator-approved historical export is required");
    args.reference_id=context.reference_id;args.as_of=dates[0];
    // The historical tool verifies its complete saved scope separately.
  } else tool="receivables_report";
  if(/\b(last|previous|yesterday|quarter|year.to.date)\b/.test(q))needs.push("Relative periods require explicit calendar dates");
  if(/\b(customer|client)\s+(named|called)\b/.test(q))needs.push("Named-customer filtering requires an explicit customer ID using the dedicated report tool");
  return needs.length?{status:"needs_clarification",reasons:needs}:{status:"ready",tool,arguments:args,definition:collection?"gross_collections_v1":tool==="receivables_report"?"current_receivables_v1":"historical_receivables_v1"};
}

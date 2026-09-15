import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test("Postgres migration, OAuth, report isolation, MCP and write lifecycle", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  // Only an explicitly supplied disposable test database is touched.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_SSL = "false";
  process.env.TOKEN_ENCRYPTION_KEY = "34".repeat(32);
  process.env.ZOHO_READ_ONLY = "false";
  process.env.ZOHO_CLIENT_ID = "synthetic-client";
    process.env.ZOHO_CLIENT_SECRET = "synthetic-secret";
    process.env.ZOHO_MIN_REQUEST_INTERVAL_MS = "0";
  process.env.ALLOWED_EMAIL_DOMAINS = "example.test";
  const db = await import("../db.js");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const { default: tools } = await import("../tools.js");
  const { z } = await import("zod");
  const { ZohoOAuthProvider, zohoCallbackHandler } = await import("../oauth.js");
  const { createApp } = await import("../server.js");
  const originalFetch = global.fetch;
  let server;
  const call = async (name, args, userId = "test-user") => {
    const tool = tools.find(t => t.name === "ZohoBooks_" + name);
    return tool.run(z.object(tool.schema).strict().parse(args), userId);
  };
  const payload = result => JSON.parse(result.content[0].text);
  try {
    await db.migrate();
    await db.upsertUser({ id: "test-user", zuid: "123", email: "finance@example.test", refreshToken: "synthetic-refresh", accountsServer: "https://accounts.zoho.com", apiDomain: "https://www.zohoapis.com", defaultOrgId: "om" });
    await db.upsertUser({ id: "other-user", zuid: "456", email: "other@example.test", refreshToken: "other-refresh", accountsServer: "https://accounts.zoho.com", apiDomain: "https://www.zohoapis.com", defaultOrgId: "om" });
    const encrypted = await pool.query("SELECT zoho_refresh_token FROM users WHERE id='test-user'");
    assert.match(encrypted.rows[0].zoho_refresh_token, /^enc:v1:/);
    assert.equal((await db.getUser("test-user")).zoho_refresh_token, "synthetic-refresh");
    // Exercise the actual legacy-data upgrade and verify it is idempotent.
    await pool.query("UPDATE users SET zoho_refresh_token='legacy-refresh' WHERE id='test-user'");
    await pool.query("INSERT INTO oauth_tokens(token,kind,client_id,user_id) VALUES('legacy-token','refresh','c','test-user')");
    await db.migrate(); await db.migrate();
    assert.equal((await db.getUser("test-user")).zoho_refresh_token, "legacy-refresh");
    assert.ok(await db.getToken("legacy-token"));
    assert.equal((await pool.query("SELECT count(*) FROM oauth_tokens WHERE token='legacy-token'")).rows[0].count, "0");
    await db.saveClient({ client_id: "c", client_secret: "client-secret", redirect_uris: ["https://client.example.test/callback"] });
    assert.equal((await db.getClient("c")).client_secret, "client-secret");
    assert.match((await pool.query("SELECT metadata FROM oauth_clients WHERE client_id='c'")).rows[0].metadata.client_secret, /^enc:v1:/);

    const provider = new ZohoOAuthProvider({ publicUrl: "https://mcp.example.test" });
    const issued = await provider._issue("c", "test-user", ["zoho_books"], "https://mcp.example.test/mcp");
    const rotated = await provider.exchangeRefreshToken({ client_id: "c" }, issued.refresh_token);
    assert.notEqual(rotated.refresh_token, issued.refresh_token);
    await assert.rejects(provider.exchangeRefreshToken({ client_id: "c" }, issued.refresh_token));
    await assert.rejects(provider.exchangeRefreshToken({ client_id: "c" }, rotated.refresh_token, ["other_scope"]));
    await provider.revokeToken({ client_id: "different" }, { token: rotated.access_token });
    assert.ok(await db.getToken(rotated.access_token));
    await provider.revokeToken({ client_id: "c" }, { token: rotated.access_token });
    assert.equal(await db.getToken(issued.access_token), null);
    assert.equal(await db.getToken(rotated.refresh_token), null);
    const atomic = await provider._issue("c", "test-user", ["zoho_books"], "https://mcp.example.test/mcp");
    await assert.rejects(db.issueTokenPair({ accessToken: atomic.access_token, refreshToken: "replacement", clientId: "c", userId: "test-user", scopes: ["zoho_books"], resource: "https://mcp.example.test/mcp", oldRefresh: atomic.refresh_token }));
    assert.ok(await db.getToken(atomic.refresh_token), "failed issuance must roll back consumption");

    let writes = 0; let currentName = "Original";let invoiceReads=0;let invoiceRetry=false;let invoiceGate,invoiceStarted;
    const invoiceRows=Array.from({length:608},(_,i)=>({invoice_id:String(i),customer_id:i===607?'late-winner':'c'+String(i%60).padStart(2,'0'),customer_name:i===607?'Late winner':'Synthetic customer '+i%60,currency_code:'OMR',balance:i===607?'1000':'1',bcy_balance:i===607?'1000':'1'}));
    let accessibleOrgs=[{organization_id:"om",name:"Oman",currency_code:"OMR",time_zone:"Asia/Muscat"}];
    global.fetch = async (url, options = {}) => {
      url = new URL(url);
      if (url.hostname === "127.0.0.1") return originalFetch(url, options);
      if (url.pathname.endsWith("/oauth/v2/token")) return Response.json({ access_token: "synthetic-access", expires_in: 3600 });
      if (url.pathname.endsWith("/organizations")) return Response.json({ code: 0, organizations: accessibleOrgs });
      if (url.pathname.endsWith("/contacts") && (options.method || "GET") === "GET") {
        assert.equal(url.searchParams.get("contact_type"), "customer");
        assert.equal(url.searchParams.get("filter_by"), "Status.All");
        return Response.json({ code: 0, contacts: [{ contact_id: "c1", contact_name: "Customer", contact_type: "customer", currency_code: "OMR", outstanding_receivable_amount: "123.456" }], page_context: { has_more_page: false } });
      }
      if (url.pathname.endsWith("/customerpayments")) return Response.json({ code: 0, customer_payments: [
        { payment_id: "1", date: "2026-08-01", amount: "200", bcy_amount: "80.123" },
        { payment_id: "2", date: "2026-08-31", currency_code: "OMR", amount: "1.234", bcy_amount: "1.234" },
      ], page_context: { has_more_page: false } });
      if(url.pathname.endsWith('/invoices')) {
        if(invoiceGate){invoiceStarted();await invoiceGate;}
        if(invoiceRetry)return Response.json({code:45},{status:429,headers:{'Retry-After':'120'}});
        const page=Number(url.searchParams.get('page'));const rows=invoiceReads++%8<4?invoiceRows:[...invoiceRows].reverse();
        return Response.json({code:0,invoices:rows.slice((page-1)*200,page*200),page_context:{page,has_more_page:page<4}});
      }
      if ((options.method || "GET") !== "GET") { writes++; return Response.json({ code: 0, contact: { contact_id: "1", contact_name: "Created" } }); }
      return Response.json({ code: 0, contact: { contact_id: "1", contact_name: currentName } });
    };
    const summary = payload(await call("collections_report", { organization_id: "om", date_start: "2026-08-01", date_end: "2026-08-31" }));
    assert.equal(summary.totals[0].amount.exact, "81.357");
    assert.equal(summary.record_count, 2);
    const receivables = payload(await call("receivables_report", { organization_id: "om" }));
    assert.equal(receivables.totals[0].amount.exact, "123.456");
    assert.equal(receivables.verification_method, "record-fields-v1");
    assert.equal(await db.getReport(receivables.report_id, "other-user"), null);
    const ranked = payload(await call("get_report", { report_id: receivables.report_id, section: "groups" }));
    assert.equal(ranked.data[0].group_id, "c1");
    assert.equal(ranked.data[0].rank_in_organization_currency, 1);
    const missingMetric=await call('list',{module:'invoices',organization_id:'om',summarize:true,group_by:'customer'});
    assert.equal(missingMetric.isError,true);assert.equal(payload(missingMetric).code,'report_metric_required');
    const fullInvoices=payload(await call('list',{module:'invoices',organization_id:'om',summarize:true,group_by:'customer',metric:'balance',currency_basis:'base'}));
    assert.equal(fullInvoices.status,'complete');assert.equal(fullInvoices.record_count,608);assert.equal(invoiceReads,8);
    assert.equal(fullInvoices.organizations[0].pages,4);assert.equal(fullInvoices.organizations[0].verification_pages,4);
    assert.equal(fullInvoices.totals[0].amount.exact,'1607');assert.equal(fullInvoices.groups[0].group_id,'late-winner');
    assert.equal(fullInvoices.groups[0].rank_in_organization_currency,1);assert.equal(fullInvoices.groups_complete,false);
    const moreGroups=payload(await call(fullInvoices.next_action.tool.replace('ZohoBooks_',''),fullInvoices.next_action.arguments));
    assert.equal(moreGroups.data.length,11);assert.equal(moreGroups.total_records,61);assert.equal(moreGroups.figures_are_complete,true);
    const countOnly=payload(await call('list',{module:'invoices',organization_id:'om',summarize:true,group_by:'customer',metric:'count'}));
    assert.equal(countOnly.amounts_calculated,false);assert.equal(countOnly.tool_for_customer_receivables.tool,'ZohoBooks_list');
    await assert.rejects(call("receivables_report", { organization_id: "om", as_of: "2026-08-31" }));
    assert.equal(await db.getReport(summary.report_id, "other-user"), null);
    assert.equal(payload(await call("get_report", { report_id: summary.report_id, section: "evidence" })).data.length, 2);
    const compared = payload(await call("reconcile_report", { report_id: summary.report_id, reference_label: "Synthetic test fixture, not finance data", records: [
      { organization_id: "om", record_id: "1", currency: "OMR", amount: "80.123" },
      { organization_id: "om", record_id: "2", currency: "OMR", amount: "1.234" },
    ] }));
    assert.equal(compared.status, "matches_supplied_reference");
    const snapshot = await db.getReport(summary.report_id, "test-user");
    await db.saveReport(summary.report_id, "test-user", snapshot.payload, snapshot.revision);
    await assert.rejects(db.saveReport(summary.report_id, "test-user", snapshot.payload, snapshot.revision));
    const rawId = randomUUID();
    const huge = { text: '\\"\n'.repeat(6000) };
    await db.saveReport(rawId, "test-user", { kind: "raw", value: huge });
    process.env.MAX_RESPONSE_CHARS = "4000";
    let offset = 0, combined = "";
    do {
      const part = await call("get_report", { report_id: rawId, section: "raw", offset });
      assert.ok(part.content[0].text.length <= 4000);
      const fragment = payload(part); combined += fragment.fragment; offset = fragment.next_offset;
    } while (offset !== undefined);
    assert.deepEqual(JSON.parse(combined).data, huge);
    delete process.env.MAX_RESPONSE_CHARS;

    const preview = payload(await call("create", { module: "contacts", organization_id: "om", idempotency_key: randomUUID(), data: { contact_name: "Created" } }));
    assert.equal(writes, 0);
    const confirmed = payload(await call("confirm_write", { operation_id: preview.operation_id, user_confirmed: true }));
    assert.equal(confirmed.state, "completed");
    await call("confirm_write", { operation_id: preview.operation_id, user_confirmed: true });
    assert.equal(writes, 1);
    assert.equal((await call("confirm_write", { operation_id: preview.operation_id, user_confirmed: true }, "other-user")).isError, true);
    const update = payload(await call("update", { module: "contacts", organization_id: "om", record_id: "1", idempotency_key: randomUUID(), data: { contact_name: "Changed" } }));
    currentName = "Externally changed";
    assert.equal((await call("confirm_write", { operation_id: update.operation_id, user_confirmed: true })).isError, true);
    assert.equal(writes, 1);
    const operationId = randomUUID();
    await db.saveWrite(operationId, "test-user", randomUUID(), {});
    const claims = await Promise.all([db.claimWrite(operationId, "test-user"), db.claimWrite(operationId, "test-user")]);
    assert.equal(claims.filter(Boolean).length, 1);

    let callbackStatus;
    await zohoCallbackHandler(provider)({ query: { code: "code", state: "state", "accounts-server": "https://evil.test" } }, {
      status(code) { callbackStatus = code; return this; }, type() { return this; }, send() { return this; },
    });
    assert.equal(callbackStatus, 500);

    const app = createApp("http://127.0.0.1:8080");
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    const localProvider = new ZohoOAuthProvider({ publicUrl: "http://127.0.0.1:8080" });
    const auth = await localProvider._issue("c", "test-user", ["zoho_books"], "http://127.0.0.1:8080/mcp");
    assert.equal((await originalFetch(origin + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const mcp = await originalFetch(origin + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + auth.access_token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(mcp.status, 200);
    const listed = await mcp.json();
    assert.ok(listed.result.tools.some(t => t.name === "ZohoBooks_collections_report"));
    assert.ok(listed.result.tools.some(t => t.name === "ZohoBooks_receivables_report"));
    const listSchema=listed.result.tools.find(t=>t.name==='ZohoBooks_list').inputSchema;
    assert.ok(listSchema.properties.metric.enum.includes('balance'));
    assert.ok(listSchema.properties.params.properties.metric.enum.includes('balance'));
    const invalidCall = await originalFetch(origin + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + auth.access_token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ZohoBooks_collections_report", arguments: { organization_id: "om", date_start: "2026-08-01", date_end: "2026-08-31", filter_by: "ignored-filter" } } }) });
    const invalidResult = await invalidCall.json();
    assert.ok(invalidResult.error || invalidResult.result?.isError);
    assert.equal(payload(invalidResult.result).code,'schema_error');
    const afterSchemaError=await db.operationalStatus('test-user');
    assert.ok(afterSchemaError.recent_failures.some(f=>f.outcome==='schema_error'&&f.reference_id===payload(invalidResult.result).reference));
    assert.equal((await db.operationalStatus('other-user')).recent_failures.length,0);
    const unknownCall=await originalFetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+auth.access_token},body:JSON.stringify({jsonrpc:'2.0',id:22,method:'tools/call',params:{name:'private-not-a-real-tool',arguments:{private_value:'never-log-this'}}})});
    const unknownBody=await unknownCall.json();
    assert.equal(payload(unknownBody.result).code,'unknown_tool');assert.equal(JSON.stringify(unknownBody).includes('private-not-a-real-tool'),false);
    const invoiceMcp=await originalFetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+auth.access_token},
      body:JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'ZohoBooks_list',arguments:{module:'invoices',organization_id:'om',summarize:true,group_by:'customer',metric:'balance',currency_basis:'base'}}})});
    const invoiceMcpResult=payload((await invoiceMcp.json()).result);
    assert.equal(invoiceMcpResult.status,'complete');assert.equal(invoiceMcpResult.record_count,608);
    assert.equal(invoiceMcpResult.groups[0].group_id,'late-winner');
    // Replay the original client's reporting input subset: params exists, but
    // metric/currency_basis and the newer tool names are not available to it.
    const oldListSchema=z.object({module:z.enum(['invoices','contacts','customer_payments']),organization_id:z.string().optional(),organization_ids:z.array(z.string()).optional(),all_organizations:z.boolean().optional(),summarize:z.boolean().optional(),group_by:z.enum(['customer','vendor','month','status','currency','aging']).optional(),page:z.number().int().min(1).optional(),per_page:z.number().int().min(1).max(200).optional(),params:z.record(z.unknown()).optional()}).strict();
    assert.throws(()=>oldListSchema.parse({module:'invoices',metric:'balance'}));
    const legacyCall=async args=>{
      oldListSchema.parse(args);
      const r=await originalFetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+auth.access_token},body:JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'ZohoBooks_list',arguments:args}})});
      const body=await r.json();assert.equal(body.result.isError,false,JSON.stringify(body));return payload(body.result);
    };
    const legacyInvoices=await legacyCall({module:'invoices',organization_id:'om',group_by:'customer',params:{metric:'balance',currency_basis:'base'}});
    assert.equal(legacyInvoices.record_count,608);assert.equal(legacyInvoices.totals[0].amount.exact,'1607');
    assert.equal(legacyInvoices.next_action.tool,'ZohoBooks_list');
    const legacyGroups=await legacyCall(legacyInvoices.next_action.arguments);
    assert.equal(legacyGroups.data.length,11);assert.equal(legacyGroups.data[0].rank_in_organization_currency,51);
    const legacyReceivables=await legacyCall({module:'contacts',organization_id:'om',params:{report_type:'receivables',currency_basis:'base'}});
    assert.equal(legacyReceivables.totals[0].amount.exact,'123.456');assert.equal(legacyReceivables.specification.kind,'receivables');
    assert.equal(legacyReceivables.specification.currency_basis,'base');
    const legacyCollections=await legacyCall({module:'customer_payments',organization_id:'om',params:{report_type:'collections',date_start:'2026-08-01',date_end:'2026-08-31'}});
    assert.equal(legacyCollections.totals[0].amount.exact,'81.357');
    process.env.REPORT_WAIT_SECONDS='0';
    const legacyPending=await legacyCall({module:'contacts',organization_id:'om',params:{report_type:'receivables'}});
    delete process.env.REPORT_WAIT_SECONDS;
    assert.equal(legacyPending.status,'processing');assert.equal(legacyPending.next_action.tool,'ZohoBooks_list');
    const legacyComplete=await legacyCall(legacyPending.next_action.arguments);
    assert.equal(legacyComplete.status,'complete');assert.equal(legacyComplete.report_id,legacyPending.report_id);
    assert.equal((await call('list',{module:'contacts',params:{report_id:legacyPending.report_id}},'other-user')).isError,true);
    assert.equal((await call('list',{module:'invoices',params:{report_id:legacyPending.report_id}})).isError,true);
    await assert.rejects(call('list',{module:'contacts',organization_id:'different',params:{report_id:legacyPending.report_id}}),/accessible/);
    await assert.rejects(call('list',{module:'invoices',organization_id:'om',metric:'count',params:{metric:'balance'}}),/Conflicting/);
    await assert.rejects(call('list',{module:'invoices',organization_id:'om',params:{organization_id:'other'}}));
    await assert.rejects(call('list',{module:'invoices',organization_id:'om',params:{filter_by:'Status.Unpaid'}}));
    assert.equal((await call('list',{module:'contacts',organization_id:'om',params:{report_type:'receivables',date_start:'2026-08-01'}})).isError,true);
    assert.equal((await call('list',{module:'invoices',organization_id:'om',params:{report_type:'receivables'}})).isError,true);

    // Reassemble genuinely oversized summaries and customer pages using only
    // the original list tool; controls inside saved raw responses must work.
    const {legacyReportClient}=await import('../report-client.js');
    const acceptanceClient=legacyReportClient(async params=>{
      oldListSchema.parse(params.arguments);
      const r=await originalFetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+auth.access_token},body:JSON.stringify({jsonrpc:'2.0',id:23,method:'tools/call',params})});
      const body=await r.json();assert.ok(!body.error);return body.result;
    });
    process.env.MAX_RESPONSE_CHARS='4000';
    try {
      const checked=await acceptanceClient.run({module:'invoices',organization_id:'om',group_by:'customer',params:{metric:'balance',currency_basis:'base'}});
      assert.equal(checked.record_count,608);assert.equal(checked.groups_read,61);assert.ok(checked.calls>4,'must exercise saved responses and multiple fragments');
    } finally {delete process.env.MAX_RESPONSE_CHARS;}

    // References below are synthetic integration data, not real finance acceptance.
    const {referenceKey}=await import("../finance-reference.js");
    const {resumeReportJob}=await import("../tools.js");
    const cleanSpec=JSON.parse(JSON.stringify(snapshot.payload.spec));
    const reference={schema_version:1,label:"Synthetic integration reference only",source:{type:"finance_export",report_name:"Synthetic receipts",exported_at:"2026-09-01T00:00:00Z",sha256:"0".repeat(64)},approval:{approved_by:"Synthetic test actor",approved_at:"2026-09-01T00:00:01Z"},definition_id:"gross_collections_v1",spec:cleanSpec,organizations:accessibleOrgs,records:[{organization_id:"om",record_id:"1",currency:"OMR",amount:"80.123"},{organization_id:"om",record_id:"2",currency:"OMR",amount:"1.234"}]};
    const referenceId=randomUUID();
    await db.saveReference(referenceId,"test-user",referenceKey(cleanSpec,accessibleOrgs),reference);
    assert.equal(await db.getReference(referenceId,"other-user"),null);
    assert.match((await pool.query("SELECT payload FROM finance_references WHERE id=$1",[referenceId])).rows[0].payload,/^enc:v1:/);
    const automatic=payload(await call("collections_report",{organization_id:"om",date_start:"2026-08-01",date_end:"2026-08-31"}));
    assert.equal(automatic.reference_check.status,"matches_supplied_reference");
    assert.ok(new Date((await db.getReport(automatic.report_id,"test-user")).expires_at)-Date.now()>29*86400000);

    // Exercise lease ownership, expiry recovery and upstream backoff in real SQL.
    process.env.REPORT_WAIT_SECONDS="0";
    const pending=payload(await call("collections_report",{organization_id:"om",date_start:"2026-08-01",date_end:"2026-08-31"}));
    delete process.env.REPORT_WAIT_SECONDS;
    assert.equal(pending.figures_are_complete,false);
    assert.equal(pending.status,'processing');assert.equal(pending.next_action.arguments.report_id,pending.report_id);
    process.env.REPORT_WAIT_SECONDS='0';
    const incompleteGroups=payload(await call('get_report',{report_id:pending.report_id,section:'groups'}));
    delete process.env.REPORT_WAIT_SECONDS;
    assert.equal(incompleteGroups.data,null);assert.equal(incompleteGroups.status,'processing');
    assert.equal(await db.claimReportJob(pending.report_id,"other-user"),null);
    const jobClaims=await Promise.all([db.claimReportJob(pending.report_id,"test-user"),db.claimReportJob(pending.report_id,"test-user")]);
    assert.equal(jobClaims.filter(Boolean).length,1);
    const abandoned=jobClaims.find(Boolean);
    await pool.query("UPDATE report_jobs SET lease_until=now()-interval '1 second' WHERE report_id=$1",[pending.report_id]);
    const recovered=await db.claimReportJob(pending.report_id,"test-user");
    assert.notEqual(recovered.lease_token,abandoned.lease_token);
    const leasedSnapshot=await db.getReport(pending.report_id,'test-user');
    await assert.rejects(db.saveJobReport(abandoned,leasedSnapshot.payload,leasedSnapshot.revision),/lease/);
    await db.finishReportJob(abandoned,"failed");
    assert.equal((await db.reportJobStatus(pending.report_id,"test-user")).state,"running");
    await db.finishReportJob(recovered,"queued",true,120000);
    assert.equal(await db.claimReportJob(pending.report_id,"test-user"),null);
    await pool.query("UPDATE report_jobs SET run_after=now() WHERE report_id=$1",[pending.report_id]);
    await resumeReportJob(await db.claimReportJob(pending.report_id,"test-user"));
    assert.equal((await db.reportJobStatus(pending.report_id,"test-user")).state,"complete");
    assert.equal(payload(await call("get_report",{report_id:pending.report_id})).data.figures_are_complete,true);
    // A rate-limited batch yields durably without a false final result or a busy retry loop.
    process.env.REPORT_WAIT_SECONDS='0';
    const throttled=payload(await call('list',{module:'invoices',organization_id:'om',summarize:true,metric:'balance'}));
    invoiceRetry=true;
    await resumeReportJob(await db.claimReportJob(throttled.report_id,'test-user'));
    const beforeRetry=await db.reportJobStatus(throttled.report_id,'test-user');
    assert.equal(beforeRetry.state,'queued');assert.ok(new Date(beforeRetry.run_after)-Date.now()>110000);
    assert.equal((await call('continue_report',{report_id:throttled.report_id})).isError,false);
    assert.equal(await db.claimReportJob(throttled.report_id,'test-user'),null);
    invoiceRetry=false;delete process.env.REPORT_WAIT_SECONDS;
    await pool.query('UPDATE report_jobs SET run_after=now() WHERE report_id=$1',[throttled.report_id]);
    assert.equal(payload(await call('continue_report',{report_id:throttled.report_id})).figures_are_complete,true);

    process.env.PUBLIC_URL=origin;
    assert.equal((await call("export_report",{report_id:automatic.report_id},"other-user")).isError,true);
    const download=payload(await call("export_report",{report_id:automatic.report_id}));
    const exported=await originalFetch(download.download_url);
    assert.equal(exported.status,200);assert.equal(exported.headers.get("cache-control"),"no-store");
    assert.equal((await exported.json()).evidence.length,2);
    assert.equal((await originalFetch(download.download_url+"x")).status,403);
    accessibleOrgs=[];
    assert.equal((await originalFetch(download.download_url)).status,403);
    accessibleOrgs=reference.organizations;
    await pool.query("UPDATE users SET email='revoked@revoked.test' WHERE id='test-user'");
    assert.equal((await originalFetch(download.download_url)).status,403);
    await pool.query("UPDATE users SET email='finance@example.test' WHERE id='test-user'");

    const historical={...reference,definition_id:"historical_receivables_v1",spec:{kind:"historical_receivables",module:"contacts",metric:"closing_balance",currency_basis:"base",as_of:"2026-08-31",group_by:"customer"}};
    const historicalId=randomUUID();await db.saveReference(historicalId,"test-user",referenceKey(historical.spec,accessibleOrgs),historical);
    assert.equal(payload(await call("historical_receivables_report",{reference_id:historicalId,organization_id:"om",as_of:"2026-08-31"})).totals[0].amount,"81.357");
    assert.equal((await call("historical_receivables_report",{reference_id:historicalId,organization_id:"om",as_of:"2026-08-30"})).isError,true);
    assert.equal((await call("historical_receivables_report",{reference_id:historicalId,organization_id:"om",as_of:"2026-08-31"},"other-user")).isError,true);

    const question=async(question,extra={})=>{
      const response=await originalFetch(origin+"/mcp",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream",Authorization:"Bearer "+auth.access_token},body:JSON.stringify({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"ZohoBooks_finance_question",arguments:{question,...extra}}})});
      const body=await response.json();assert.equal(body.result.isError,false,JSON.stringify(body));return body.result.content.map(c=>JSON.parse(c.text));
    };
    assert.equal((await question("Collections for August 2026",{organization_id:"om"}))[1].totals[0].amount.exact,"81.357");
    assert.equal((await question("Outstanding receivables by customer",{organization_id:"om"}))[1].totals[0].amount.exact,"123.456");
    assert.equal((await question("Net collections for August 2026",{organization_id:"om"}))[0].status,"needs_clarification");
    process.env.EXPECTED_ORGANIZATION_IDS="om,ae,sa,qa,bh";
    accessibleOrgs=["om","ae","sa","qa","bh"].map(organization_id=>({organization_id,name:"Synthetic "+organization_id,currency_code:"OMR",time_zone:"Asia/Muscat"}));
    process.env.REPORT_WAIT_SECONDS="10";
    await assert.rejects(call("receivables_report",{all_organizations:true,organization_id:"om"}),/exactly one/);
    const all=(await question("Outstanding receivables for all five entities"))[1];
    assert.equal(all.entity_coverage.status,"all_expected_entities_covered");assert.equal(all.totals.length,5);
    accessibleOrgs=accessibleOrgs.slice(1);
    await assert.rejects(call("receivables_report",{all_organizations:true}),/accessible|access/i);
    delete process.env.EXPECTED_ORGANIZATION_IDS;delete process.env.REPORT_WAIT_SECONDS;
    await assert.rejects(call("receivables_report",{all_organizations:true}),/not configured/);
    accessibleOrgs=reference.organizations;
    process.env.REPORT_WAIT_SECONDS="0";
    const doomed=payload(await call("collections_report",{organization_id:"om",date_start:"2026-08-01",date_end:"2026-08-31"}));
    delete process.env.REPORT_WAIT_SECONDS;
    await pool.query("UPDATE report_jobs SET failures=4 WHERE report_id=$1",[doomed.report_id]);
    await pool.query("UPDATE users SET email='revoked@revoked.test' WHERE id='test-user'");
    await resumeReportJob(await db.claimReportJob(doomed.report_id,"test-user"));
    assert.equal((await db.reportJobStatus(doomed.report_id,"test-user")).state,"failed");
    assert.equal((await db.getReport(doomed.report_id,"test-user")).payload.organizations[0].blocked,true);
    await pool.query("UPDATE users SET email='finance@example.test' WHERE id='test-user'");
    process.env.REPORT_WAIT_SECONDS="0";
    const failedReportRead=await originalFetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+auth.access_token},body:JSON.stringify({jsonrpc:'2.0',id:24,method:'tools/call',params:{name:'ZohoBooks_list',arguments:{module:'customer_payments',params:{report_id:doomed.report_id,section:'summary'}}}})});
    const failedReportBody=await failedReportRead.json();
    assert.equal(payload(failedReportBody.result).data.status,'failed_validation');
    assert.ok((await db.operationalStatus('test-user')).recent_failures.some(f=>f.outcome==='verification_failed'&&f.report_id===doomed.report_id));
    const background=payload(await call("collections_report",{organization_id:"om",date_start:"2026-08-01",date_end:"2026-08-31"}));
    delete process.env.REPORT_WAIT_SECONDS;
    const {startReportWorker}=await import("../report-worker.js");
    const stopWorker=startReportWorker(resumeReportJob,10);
    try {
      const deadline=Date.now()+3000;
      while((await db.reportJobStatus(background.report_id,"test-user")).state!=="complete"&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
      assert.equal((await db.reportJobStatus(background.report_id,"test-user")).state,"complete");
    } finally {stopWorker();}
    // Shutdown releases only this process's owned leases. Late work cannot save
    // after release, even if no other worker has modified the snapshot revision.
    process.env.REPORT_WAIT_SECONDS='0';
    const interrupted=payload(await call('list',{module:'invoices',organization_id:'om',summarize:true,metric:'balance'}));
    delete process.env.REPORT_WAIT_SECONDS;
    let unblock;invoiceGate=new Promise(resolve=>unblock=resolve);
    const started=new Promise(resolve=>invoiceStarted=resolve);
    const interruptedJob=await db.claimReportJob(interrupted.report_id,'test-user');
    const inFlight=resumeReportJob(interruptedJob);
    await started;
    process.env.REPORT_WAIT_SECONDS='1';
    const waitStarted=Date.now();
    const checkpoint=payload(await call('continue_report',{report_id:interrupted.report_id}));
    delete process.env.REPORT_WAIT_SECONDS;
    assert.ok(Date.now()-waitStarted<3000,'a slow Zoho request must not hold the MCP response indefinitely');
    assert.equal(checkpoint.status,'processing');assert.equal(checkpoint.next_action.arguments.report_id,interrupted.report_id);
    assert.equal((await db.reportJobStatus(interrupted.report_id,'test-user')).state,'running');
    const {stopReportJobs}=await import('../tools.js');await stopReportJobs(0);
    assert.equal((await db.reportJobStatus(interrupted.report_id,'test-user')).state,'queued');
    unblock();await inFlight;invoiceGate=undefined;
    assert.equal((await db.getReport(interrupted.report_id,'test-user')).revision,0);
    assert.equal((await db.reportJobStatus(interrupted.report_id,'test-user')).state,'queued');
    await db.cleanup();
  } finally {
    global.fetch = originalFetch;
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end(); await db.close();
  }
});

import * as db from "./db.js";
import { READ_ONLY, zohoOrigin } from "./security.js";
import { requestJson, booksSuccess } from "./http.js";

const READ_SCOPES = ["contacts", "invoices", "estimates", "salesorders", "purchaseorders", "expenses",
  "customerpayments", "bills", "vendorpayments", "creditnotes", "debitnotes", "settings", "banking", "accountants", "users"];
export const ZOHO_SCOPES = (READ_ONLY
  ? READ_SCOPES.map(s => `ZohoBooks.${s}.READ`).join(",")
  : "ZohoBooks.fullaccess.all") + ",AaaServer.profile.READ";

export function zohoAuthorizeUrl({ state, redirectUri }) {
  const url = new URL(zohoOrigin(process.env.ZOHO_AUTH_BASE || "https://accounts.zoho.com") + "/oauth/v2/auth");
  for (const [key, value] of Object.entries({ response_type: "code", client_id: process.env.ZOHO_CLIENT_ID,
    scope: ZOHO_SCOPES, redirect_uri: redirectUri, access_type: "offline", prompt: "consent", state })) {
    url.searchParams.set(key, value);
  }
  return url.href;
}
async function tokenRequest(accountsServer, fields) {
  const r = await requestJson(zohoOrigin(accountsServer) + "/oauth/v2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.ZOHO_CLIENT_ID, client_secret: process.env.ZOHO_CLIENT_SECRET, ...fields }),
  });
  if (!r.httpOk || typeof r.data?.access_token !== "string" || r.data.error) throw new Error("Zoho authorization failed; reconnect your account");
  if (r.data.api_domain) zohoOrigin(r.data.api_domain, "api");
  return r.data;
}
export async function exchangeZohoCode({ accountsServer, code, redirectUri }) {
  const tokens = await tokenRequest(accountsServer, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (typeof tokens.refresh_token !== "string") throw new Error("Zoho did not return an offline refresh token; reconnect with consent");
  return tokens;
}
export async function fetchZohoUserInfo({ accountsServer, accessToken }) {
  const r = await requestJson(zohoOrigin(accountsServer) + "/oauth/user/info", { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
  if (!r.httpOk || !r.data?.ZUID) throw new Error("Could not verify Zoho identity");
  return { zuid: String(r.data.ZUID), email: r.data.Email, displayName: r.data.Display_Name };
}
const cache = new Map();
const refreshing = new Map();
export function invalidateTokenCache(userId) { cache.delete(userId); }
async function accessTokenFor(user, force = false) {
  const revision = String(user.updated_at);
  const key = `${user.id}:${revision}`;
  const cached = cache.get(user.id);
  if (!force && cached?.revision === revision && Date.now() < cached.expiresAt - 60000) return cached.token;
  if (refreshing.has(key)) return refreshing.get(key);
  const promise = (async () => {
    const r = await tokenRequest(user.zoho_accounts_server, { grant_type: "refresh_token", refresh_token: user.zoho_refresh_token });
    const ttl = Number(r.expires_in ?? r.expires_in_sec ?? 3600);
    cache.set(user.id, { token: r.access_token, revision, expiresAt: Date.now() + (Number.isFinite(ttl) ? ttl : 3600) * 1000 });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return r.access_token;
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, promise);
  return promise;
}
function apiUrl(domain, path, query) {
  const url = new URL(zohoOrigin(domain, "api") + "/books/v3" + path);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return url;
}
export async function zohoApiRaw({ apiDomain, accessToken, method, path, query = {} }) {
  const r = await requestJson(apiUrl(apiDomain, path, query), { method, headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
  if (!booksSuccess(r)) throw new Error("Zoho Books rejected the request");
  return r.data;
}
export async function zohoRequest(userId, { method, path, query = {}, body, noOrg = false }) {
  if (READ_ONLY && method !== "GET") return { ok: false, text: "Accounting writes are disabled" };
  const user = await db.getUser(userId);
  if (!user) return { ok: false, status: 401, text: "Reconnect your Zoho account" };
  if (!noOrg && !query.organization_id) return { ok: false, text: "An explicit organization_id is required" };
  try {
    let token = await accessTokenFor(user);
    const call = () => requestJson(apiUrl(user.zoho_api_domain, path, query), {
      method, headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let r = await call();
    if (r.status === 401 && method === "GET") { token = await accessTokenFor(user, true); r = await call(); }
    if (!booksSuccess(r)) return { ok: false, status: r.status, text: `Zoho Books rejected the request (HTTP ${r.status}, code ${String(r.data?.code ?? "unknown").slice(0, 20)}). No result was verified.` };
    return { ok: true, status: r.status, data: r.data, text: JSON.stringify(r.data) };
  } catch {
    return { ok: false, text: method === "GET" ? "Zoho read failed or timed out; retry the report" : "Write outcome is unknown. Inspect Zoho before attempting another operation." };
  }
}

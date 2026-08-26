// Zoho Books API client — multi-tenant.
//
// ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET identify *this application* and are shared by all
// users. Each user's own refresh token, accounts server and API domain live in the
// database and are resolved per request, so one deployment serves many Zoho accounts.

import * as db from "./db.js";

// Server-based apps always begin the authorization request here, regardless of which
// datacenter the user actually lives in; Zoho redirects and tells us via `accounts-server`.
const AUTH_BASE = process.env.ZOHO_AUTH_BASE || "https://accounts.zoho.com";

export const ZOHO_SCOPES = "ZohoBooks.fullaccess.all,AaaServer.profile.READ";

const MAX_CHARS = Number(process.env.MAX_RESPONSE_CHARS || 60000);

export function zohoAuthorizeUrl({ state, redirectUri }) {
  const url = new URL(`${AUTH_BASE}/oauth/v2/auth`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.ZOHO_CLIENT_ID || "");
  url.searchParams.set("scope", ZOHO_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  // offline + consent are both required for Zoho to hand back a refresh token.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.href;
}

/** Exchanges the code from Zoho's callback for that user's tokens. */
export async function exchangeZohoCode({ accountsServer, code, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.ZOHO_CLIENT_ID || "",
    client_secret: process.env.ZOHO_CLIENT_SECRET || "",
    redirect_uri: redirectUri,
    code,
  });
  const resp = await fetch(`${accountsServer}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await resp.json().catch(() => ({}));
  if (!json.refresh_token) {
    throw new Error(
      `Zoho did not return a refresh token: ${JSON.stringify(json)}. ` +
        `Confirm the redirect URI is registered exactly and that the client is a ` +
        `Server-based Application (not a Self Client).`
    );
  }
  return json; // { access_token, refresh_token, api_domain, expires_in }
}

/** Reads the signed-in Zoho user's identity (needs the AaaServer.profile.READ scope). */
export async function fetchZohoUserInfo({ accountsServer, accessToken }) {
  const resp = await fetch(`${accountsServer}/oauth/user/info`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const json = await resp.json().catch(() => ({}));
  if (!json.ZUID) throw new Error(`Could not read Zoho profile: ${JSON.stringify(json)}`);
  return { zuid: String(json.ZUID), email: json.Email, displayName: json.Display_Name };
}

// ---------------------------------------------------------------------------
// Per-user access tokens
// ---------------------------------------------------------------------------

const tokenCache = new Map(); // userId -> { token, expiresAt }

async function accessTokenFor(user, force = false) {
  const cached = tokenCache.get(user.id);
  if (!force && cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: user.zoho_refresh_token,
    client_id: process.env.ZOHO_CLIENT_ID || "",
    client_secret: process.env.ZOHO_CLIENT_SECRET || "",
  });
  const resp = await fetch(`${user.zoho_accounts_server}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await resp.json().catch(() => ({}));
  if (!json.access_token) {
    throw new Error(
      `Could not refresh this user's Zoho access token: ${JSON.stringify(json)}. ` +
        `They may have revoked access — reconnecting the app in ChatGPT will fix it.`
    );
  }
  const ttl = Number(json.expires_in ?? json.expires_in_sec ?? 3600);
  tokenCache.set(user.id, { token: json.access_token, expiresAt: Date.now() + ttl * 1000 });
  return json.access_token;
}

/** Raw Books API call for a user we already hold in hand (used during onboarding). */
export async function zohoApiRaw({ apiDomain, accessToken, method, path, query = {} }) {
  const url = new URL(apiDomain + "/books/v3" + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: "application/json" },
  });
  return resp.json().catch(() => null);
}

/**
 * Call the Zoho Books v3 API as a specific user.
 * Returns { ok, status, data, text } — API-level failures come back as readable text
 * rather than exceptions, so the model gets something it can act on.
 */
export async function zohoRequest(userId, { method, path, query = {}, body, noOrg = false, _retried = false }) {
  const user = await db.getUser(userId);
  if (!user) {
    return {
      ok: false,
      status: 401,
      text:
        "This ChatGPT account is not linked to a Zoho Books account yet. Disconnect and " +
        "reconnect the Zoho Books app to sign in with Zoho.",
    };
  }

  const token = await accessTokenFor(user);
  const url = new URL(user.zoho_api_domain + "/books/v3" + path);

  const finalQuery = { ...query };
  if (!noOrg && !finalQuery.organization_id && user.default_org_id) {
    finalQuery.organization_id = user.default_org_id;
  }
  for (const [k, v] of Object.entries(finalQuery)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (resp.status === 401 && !_retried) {
    await accessTokenFor(user, true);
    return zohoRequest(userId, { method, path, query, body, noOrg, _retried: true });
  }

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (resp.status === 429) {
    return {
      ok: false,
      status: 429,
      text:
        "Zoho Books rate limit hit (HTTP 429). Wait a moment and retry, or request fewer " +
        "records per call with per_page.",
    };
  }

  if (!resp.ok) {
    const msg = data?.message || text || `HTTP ${resp.status}`;
    return {
      ok: false,
      status: resp.status,
      text: `Zoho Books API error (HTTP ${resp.status}, code ${data?.code ?? "n/a"}): ${msg}`,
    };
  }

  let out = data === null ? text : JSON.stringify(data, null, 2);
  if (out.length > MAX_CHARS) {
    out =
      out.slice(0, MAX_CHARS) +
      `\n\n... [truncated at ${MAX_CHARS} characters. Use per_page/page to paginate, ` +
      `or filter the query to narrow the result set.]`;
  }

  return { ok: true, status: resp.status, data, text: out };
}

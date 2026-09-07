// Multi-tenant OAuth 2.1 authorization server.
//
// ChatGPT authenticates against this server; this server in turn sends the human to
// Zoho's own consent screen. Whoever signs in there determines which Zoho Books account
// the resulting tokens can reach — so each colleague gets their own books, and nobody
// shares credentials.
//
//   ChatGPT ──/authorize──▶ us ──redirect──▶ Zoho consent
//                                              │
//   ChatGPT ◀──code+state── us ◀──/zoho/callback (code, location, accounts-server)

import { randomBytes } from "node:crypto";
import * as db from "./db.js";
import { zohoOrigin } from "./security.js";
import { InvalidGrantError, InvalidTokenError, InvalidScopeError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  zohoAuthorizeUrl,
  exchangeZohoCode,
  fetchZohoUserInfo,
  zohoApiRaw,
  invalidateTokenCache,
} from "./zoho.js";

const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const ACCESS_TTL_S = 3600;

const randomToken = () => randomBytes(32).toString("hex");

const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS || "")
  .split(",")
  .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
  .filter(Boolean);

function emailAllowed(email) {
  if (!allowedDomains.length) return true;
  const domain = String(email || "").split("@")[1]?.toLowerCase();
  return Boolean(domain && allowedDomains.includes(domain));
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page({ title, message, tone = "error" }) {
  const accent = tone === "ok" ? "#22c55e" : "#f87171";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; background:#0b0f14; color:#e6edf3;
         display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:24px; }
  .card { background:#151b23; border:1px solid #2a3441; border-radius:12px; padding:32px; max-width:460px; }
  h1 { font-size:18px; margin:0 0 12px; color:${accent}; }
  p { font-size:14px; color:#9fb0c0; line-height:1.6; margin:0 0 8px; }
  code { background:#0b0f14; padding:2px 6px; border-radius:4px; font-size:13px; }
</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${message}</p></div></body></html>`;
}

// ---------------------------------------------------------------------------

export class ClientsStore {
  async getClient(clientId) {
    return db.getClient(clientId);
  }
  async registerClient(metadata) {
    return db.saveClient(metadata);
  }
}

export class ZohoOAuthProvider {
  constructor({ publicUrl }) {
    this.publicUrl = publicUrl.replace(/\/+$/, "");
    this.clientsStore = new ClientsStore();
  }

  get zohoRedirectUri() {
    return `${this.publicUrl}/zoho/callback`;
  }

  /** Step 1: park ChatGPT's request and bounce the human to Zoho. */
  async authorize(client, params, res) {
    if (params.resource && String(params.resource) !== this.publicUrl + "/mcp") throw new InvalidGrantError("Invalid resource");
    if (params.scopes?.some(scope => scope !== "zoho_books")) throw new InvalidScopeError("Unsupported scope");
    const stateId = randomToken();
    await db.createPendingAuth(
      stateId,
      client.client_id,
      {
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state ?? null,
        scopes: params.scopes ?? [],
        resource: this.publicUrl + "/mcp",
      },
      PENDING_TTL_MS
    );

    res.redirect(zohoAuthorizeUrl({ state: stateId, redirectUri: this.zohoRedirectUri }));
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const entry = await db.peekCode(authorizationCode);
    if (!entry || entry.client_id !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return entry.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _verifier, redirectUri, resource) {
    const pending = await db.peekCode(authorizationCode);
    if (!pending || pending.client_id !== client.client_id || (redirectUri && redirectUri !== pending.params.redirectUri) ||
        (resource && String(resource) !== pending.params.resource)) throw new InvalidGrantError("Code binding mismatch");
    return this._issue(client.client_id, pending.user_id, pending.params.scopes, pending.params.resource, { code: authorizationCode });
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const existing = await db.getToken(refreshToken);
    if (resource && String(resource) !== existing?.resource) throw new InvalidGrantError("Resource mismatch");
    if (scopes?.some(scope => !existing?.scopes?.includes(scope))) throw new InvalidScopeError("Cannot expand scopes");
    const row = existing;
    if (!row || row.kind !== "refresh" || row.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    return this._issue(client.client_id, row.user_id, scopes ?? row.scopes, row.resource, { oldRefresh: refreshToken });
  }

  async _issue(clientId, userId, scopes, resource, consumed = {}) {
    const access_token = randomToken();
    const refresh_token = randomToken();
    try {
      await db.issueTokenPair({ accessToken: access_token, refreshToken: refresh_token, clientId, userId, scopes, resource, ...consumed });
    } catch (error) {
      if (error.message === 'Credential already used or expired') throw new InvalidGrantError(error.message);
      throw error;
    }

    return {
      access_token,
      token_type: "bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token,
      scope: (scopes ?? []).join(" "),
    };
  }

  /** Identity for every downstream tool call lives in `extra.userId`. */
  async verifyAccessToken(token) {
    const row = await db.getToken(token);
    if (!row || row.kind !== "access") throw new InvalidTokenError("Invalid or expired token");
    if (row.resource && row.resource !== this.publicUrl + "/mcp") throw new InvalidTokenError("Wrong token audience");
    const user = await db.getUser(row.user_id);
    if (!user || !emailAllowed(user.email)) throw new InvalidTokenError("Account access is no longer permitted");
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes ?? [],
      expiresAt: row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : undefined,
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: row.user_id },
    };
  }

  async revokeToken(client, request) {
    await db.revokeGrant(request.token, client.client_id);
  }
}

// ---------------------------------------------------------------------------
// Zoho's redirect lands here.
// ---------------------------------------------------------------------------

export function zohoCallbackHandler(provider) {
  return async (req, res) => {
    const send = (status, html) => res.status(status).type("html").send(html);

    try {
      const { code, state, error } = req.query;
      const accountsServer = zohoOrigin(req.query["accounts-server"] || process.env.ZOHO_AUTH_BASE || "https://accounts.zoho.com");

      if (error) {
        return send(400, page({ title: "Zoho declined the request", message: esc(String(error)) }));
      }
      if (typeof code !== "string" || typeof state !== "string" || !code || !state) {
        return send(400, page({ title: "Malformed callback", message: "Zoho did not return a code." }));
      }

      const pending = await db.consumePendingAuth(String(state));
      if (!pending) {
        return send(
          400,
          page({
            title: "This sign-in link expired",
            message: "Go back to ChatGPT and click Connect on the Zoho Books app again.",
          })
        );
      }

      // Swap Zoho's code for this user's long-lived refresh token.
      const tokens = await exchangeZohoCode({
        accountsServer: String(accountsServer),
        code: String(code),
        redirectUri: provider.zohoRedirectUri,
      });

      const info = await fetchZohoUserInfo({
        accountsServer: String(accountsServer),
        accessToken: tokens.access_token,
      });

      if (!emailAllowed(info.email)) {
        return send(
          403,
          page({
            title: "Account not permitted",
            message:
              `<code>${esc(info.email || "this account")}</code> is not in an allowed domain. ` +
              `Sign in with your company Zoho account.`,
          })
        );
      }

      const apiDomain = zohoOrigin(tokens.api_domain, "api");

      // Pick a sensible default organization so tools work without one being passed.
      let defaultOrgId = null;
      try {
        const orgs = await zohoApiRaw({
          apiDomain,
          accessToken: tokens.access_token,
          method: "GET",
          path: "/organizations",
        });
        const list = orgs?.organizations ?? [];
        defaultOrgId = (list.find((o) => o.is_default_org) ?? list[0])?.organization_id ?? null;
      } catch {
        // Non-fatal: the user can still pass organization_id per call.
      }

      const user = await db.upsertUser({
        id: `zoho_${info.zuid}`,
        zuid: info.zuid,
        email: info.email,
        displayName: info.displayName,
        refreshToken: tokens.refresh_token,
        accountsServer: String(accountsServer),
        apiDomain,
        defaultOrgId,
      });
      invalidateTokenCache(user.id);

      console.log(`[oauth] linked ${info.email ?? info.zuid} (org ${defaultOrgId ?? "none"})`);

      // Hand ChatGPT its own authorization code.
      const appCode = randomToken();
      await db.createCode(appCode, pending.client_id, user.id, pending.params, CODE_TTL_MS);

      const back = new URL(pending.params.redirectUri);
      back.searchParams.set("code", appCode);
      if (pending.params.state) back.searchParams.set("state", pending.params.state);
      return res.redirect(302, back.href);
    } catch (err) {
      console.error("[oauth] callback failed", { type: err.name });
      return send(500, page({ title: "Could not complete sign-in", message: "Sign-in could not be verified. Check the registered Zoho region and redirect URI, then reconnect." }));
    }
  };
}

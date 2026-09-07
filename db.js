// Postgres persistence. Everything that used to live in memory lives here, so a
// restart or redeploy no longer invalidates connected clients or user sessions.

import pg from "pg";
import { encrypt, decrypt, tokenHash, validateEncryptionKey } from "./security.js";

// Managed Postgres (Railway, Neon, RDS) requires TLS; a Postgres container on the same
// Docker network does not offer it at all, and forcing TLS there fails the connection.
// DATABASE_SSL overrides the guess when neither default is right.
function useSsl() {
  const explicit = process.env.DATABASE_SSL;
  if (explicit !== undefined) {
    return !["false", "0", "no", "off"].includes(explicit.trim().toLowerCase());
  }
  const url = process.env.DATABASE_URL || "";
  return !/@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(url);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl() ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_PEM && { ca: process.env.DATABASE_CA_PEM.replace(/\\n/g, "\n") }) } : false,
  max: 5,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
});

pool.on("error", (err) => console.error("[db] idle client error:", err.message));

export async function migrate() {
  validateEncryptionKey();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                   TEXT PRIMARY KEY,
      zoho_zuid            TEXT UNIQUE NOT NULL,
      email                TEXT,
      display_name         TEXT,
      zoho_refresh_token   TEXT NOT NULL,
      zoho_accounts_server TEXT NOT NULL,
      zoho_api_domain      TEXT NOT NULL,
      default_org_id       TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id  TEXT PRIMARY KEY,
      metadata   JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pending_auth (
      id         TEXT PRIMARY KEY,
      client_id  TEXT NOT NULL,
      params     JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_codes (
      code       TEXT PRIMARY KEY,
      client_id  TEXT NOT NULL,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      params     JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token      TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      client_id  TEXT NOT NULL,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scopes     TEXT[] NOT NULL DEFAULT '{}',
      resource   TEXT,
      expires_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS oauth_tokens_user_idx ON oauth_tokens(user_id);
    CREATE TABLE IF NOT EXISTS report_snapshots (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS write_operations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_key TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'preview',
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, request_key)
    );
  `);

  // Transactional, restart-safe upgrade of legacy plaintext credentials.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users, oauth_tokens, oauth_clients IN EXCLUSIVE MODE');
    const users = await client.query('SELECT id, zoho_refresh_token FROM users');
    for (const row of users.rows) {
      if (!row.zoho_refresh_token.startsWith('enc:v1:')) {
        await client.query('UPDATE users SET zoho_refresh_token=$2 WHERE id=$1', [row.id, encrypt(row.zoho_refresh_token)]);
      } else decrypt(row.zoho_refresh_token); // Fail startup if the deployment key is wrong.
    }
    const tokens = await client.query("SELECT token FROM oauth_tokens WHERE token NOT LIKE 'sha256:%'");
    for (const row of tokens.rows) await client.query('UPDATE oauth_tokens SET token=$2 WHERE token=$1', [row.token, tokenHash(row.token)]);
    const clients = await client.query('SELECT client_id, metadata FROM oauth_clients');
    for (const row of clients.rows) {
      if (row.metadata.client_secret && !row.metadata.client_secret.startsWith('enc:v1:')) {
        await client.query('UPDATE oauth_clients SET metadata=$2 WHERE client_id=$1', [row.client_id, { ...row.metadata, client_secret: encrypt(row.metadata.client_secret) }]);
      }
    }
    await client.query("UPDATE oauth_tokens SET expires_at=now()+interval '30 days' WHERE kind='refresh' AND expires_at IS NULL");
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }

  // Opportunistic cleanup of anything already expired.
  await pool
    .query(
      `DELETE FROM pending_auth WHERE expires_at < now();
       DELETE FROM oauth_codes  WHERE expires_at < now();
       DELETE FROM oauth_tokens WHERE expires_at < now();
       DELETE FROM report_snapshots WHERE expires_at < now();
       DELETE FROM write_operations WHERE state = 'preview' AND expires_at < now();`
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function upsertUser(u) {
  const { rows } = await pool.query(
    `INSERT INTO users (id, zoho_zuid, email, display_name, zoho_refresh_token,
                        zoho_accounts_server, zoho_api_domain, default_org_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (zoho_zuid) DO UPDATE SET
       email                = EXCLUDED.email,
       display_name         = EXCLUDED.display_name,
       zoho_refresh_token   = EXCLUDED.zoho_refresh_token,
       zoho_accounts_server = EXCLUDED.zoho_accounts_server,
       zoho_api_domain      = EXCLUDED.zoho_api_domain,
       default_org_id       = COALESCE(EXCLUDED.default_org_id, users.default_org_id),
       updated_at           = now()
     RETURNING *`,
    [
      u.id,
      u.zuid,
      u.email ?? null,
      u.displayName ?? null,
      encrypt(u.refreshToken),
      u.accountsServer,
      u.apiDomain,
      u.defaultOrgId ?? null,
    ]
  );
  return rows[0];
}

export async function getUser(id) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ? { ...rows[0], zoho_refresh_token: decrypt(rows[0].zoho_refresh_token) } : null;
}

export async function setDefaultOrg(id, orgId) {
  await pool.query(`UPDATE users SET default_org_id = $2, updated_at = now() WHERE id = $1`, [id, orgId]);
}

export async function listUsers() {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, default_org_id, created_at FROM users ORDER BY created_at`
  );
  return rows;
}

// ---------------------------------------------------------------------------
// OAuth clients (registered by ChatGPT via Dynamic Client Registration)
// ---------------------------------------------------------------------------

export async function getClient(clientId) {
  const { rows } = await pool.query(`SELECT metadata FROM oauth_clients WHERE client_id = $1`, [clientId]);
  const metadata = rows[0]?.metadata;
  return metadata ? { ...metadata, ...(metadata.client_secret && { client_secret: decrypt(metadata.client_secret) }) } : undefined;
}

export async function saveClient(metadata) {
  await pool.query(
    `INSERT INTO oauth_clients (client_id, metadata) VALUES ($1,$2)
     ON CONFLICT (client_id) DO UPDATE SET metadata = EXCLUDED.metadata`,
    [metadata.client_id, { ...metadata, ...(metadata.client_secret && { client_secret: encrypt(metadata.client_secret) }) }]
  );
  return metadata;
}

// ---------------------------------------------------------------------------
// Pending authorizations (in flight: ChatGPT -> us -> Zoho -> back)
// ---------------------------------------------------------------------------

export async function createPendingAuth(id, clientId, params, ttlMs) {
  await pool.query(
    `INSERT INTO pending_auth (id, client_id, params, expires_at)
     VALUES ($1,$2,$3, now() + ($4::int * interval '1 millisecond'))`,
    [id, clientId, params, ttlMs]
  );
}

export async function consumePendingAuth(id) {
  const { rows } = await pool.query(
    `DELETE FROM pending_auth WHERE id = $1 AND expires_at > now() RETURNING client_id, params`,
    [id]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export async function createCode(code, clientId, userId, params, ttlMs) {
  await pool.query(
    `INSERT INTO oauth_codes (code, client_id, user_id, params, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5::int * interval '1 millisecond'))`,
    [code, clientId, userId, params, ttlMs]
  );
}

export async function peekCode(code) {
  const { rows } = await pool.query(
    `SELECT client_id, user_id, params FROM oauth_codes WHERE code = $1 AND expires_at > now()`,
    [code]
  );
  return rows[0] ?? null;
}

export async function consumeCode(code) {
  const { rows } = await pool.query(
    `DELETE FROM oauth_codes WHERE code = $1 AND expires_at > now()
     RETURNING client_id, user_id, params`,
    [code]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Access / refresh tokens issued by this server to MCP clients
// ---------------------------------------------------------------------------

export async function saveToken({ token, kind, clientId, userId, scopes, resource, ttlMs }) {
  await pool.query(
    `INSERT INTO oauth_tokens (token, kind, client_id, user_id, scopes, resource, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::bigint IS NULL THEN NULL
                                     ELSE now() + ($7::bigint * interval '1 millisecond') END)`,
    [tokenHash(token), kind, clientId, userId, scopes ?? [], resource ?? null, ttlMs ?? null]
  );
}

export async function getToken(token) {
  const { rows } = await pool.query(
    `SELECT * FROM oauth_tokens
     WHERE token = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [tokenHash(token)]
  );
  return rows[0] ?? null;
}

export async function deleteToken(token) {
  await pool.query(`DELETE FROM oauth_tokens WHERE token = $1`, [tokenHash(token)]);
}

export async function consumeRefreshToken(token, clientId) {
  const { rows } = await pool.query("DELETE FROM oauth_tokens WHERE token=$1 AND client_id=$2 AND kind='refresh' AND expires_at>now() RETURNING *", [tokenHash(token), clientId]);
  return rows[0];
}
export async function revokeGrant(token, clientId) {
  await pool.query(`DELETE FROM oauth_tokens WHERE (user_id, client_id) IN
    (SELECT user_id, client_id FROM oauth_tokens WHERE token=$1 AND client_id=$2)`, [tokenHash(token), clientId]);
}
// Consume the old credential and store both replacements in one transaction.
export async function issueTokenPair({ accessToken, refreshToken, clientId, userId, scopes, resource, oldRefresh, code }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (oldRefresh) {
      const consumed = await client.query("DELETE FROM oauth_tokens WHERE token=$1 AND client_id=$2 AND user_id=$3 AND kind='refresh' AND expires_at>now() RETURNING token", [tokenHash(oldRefresh),clientId,userId]);
      if (!consumed.rowCount) throw new Error('Credential already used or expired');
    }
    if (code) {
      const consumed = await client.query('DELETE FROM oauth_codes WHERE code=$1 AND client_id=$2 AND user_id=$3 AND expires_at>now() RETURNING code', [code,clientId,userId]);
      if (!consumed.rowCount) throw new Error('Credential already used or expired');
    }
    for (const [token,kind,ttl] of [[accessToken,'access',3600],[refreshToken,'refresh',2592000]]) {
      await client.query("INSERT INTO oauth_tokens(token,kind,client_id,user_id,scopes,resource,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+($7::int * interval '1 second'))", [tokenHash(token),kind,clientId,userId,scopes || [],resource,ttl]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function saveReport(id, userId, payload, revision = null) {
  const value = encrypt(JSON.stringify(payload));
  if (revision === null) {
    await pool.query("INSERT INTO report_snapshots(id,user_id,payload,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')", [id,userId,value]);
  } else {
    const r = await pool.query("UPDATE report_snapshots SET payload=$3, revision=revision+1 WHERE id=$1 AND user_id=$2 AND revision=$4 AND expires_at>now()", [id,userId,value,revision]);
    if (!r.rowCount) throw new Error('Report changed in another request; reload it');
  }
}
export async function getReport(id, userId) {
  const { rows } = await pool.query('SELECT payload,revision FROM report_snapshots WHERE id=$1 AND user_id=$2 AND expires_at>now()', [id,userId]);
  return rows[0] ? { payload: JSON.parse(decrypt(rows[0].payload)), revision: rows[0].revision } : null;
}
export async function saveWrite(id, userId, key, payload) {
  const r = await pool.query("INSERT INTO write_operations(id,user_id,request_key,payload,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes') ON CONFLICT(user_id,request_key) DO NOTHING RETURNING id", [id,userId,key,encrypt(JSON.stringify(payload))]);
  if (!r.rowCount) throw new Error('This operation key already exists; inspect its existing outcome before retrying');
}
export async function getWrite(id, userId) {
  const { rows } = await pool.query('SELECT payload,state,expires_at FROM write_operations WHERE id=$1 AND user_id=$2', [id,userId]);
  return rows[0] ? { ...rows[0], payload: JSON.parse(decrypt(rows[0].payload)) } : null;
}
export async function claimWrite(id, userId) {
  const r = await pool.query("UPDATE write_operations SET state='executing' WHERE id=$1 AND user_id=$2 AND state='preview' AND expires_at>now() RETURNING id", [id,userId]);
  return Boolean(r.rowCount);
}
export async function finishWrite(id, userId, state, payload) {
  await pool.query('UPDATE write_operations SET state=$3,payload=$4 WHERE id=$1 AND user_id=$2', [id,userId,state,encrypt(JSON.stringify(payload))]);
}

export async function close() {
  await pool.end();
}

export async function health() { await pool.query('SELECT 1'); }
export async function cleanup() {
  await pool.query(`DELETE FROM pending_auth WHERE expires_at < now();
    DELETE FROM oauth_codes WHERE expires_at < now();
    DELETE FROM oauth_tokens WHERE expires_at < now();
    DELETE FROM report_snapshots WHERE expires_at < now();
    DELETE FROM write_operations WHERE state='preview' AND expires_at < now();`);
}

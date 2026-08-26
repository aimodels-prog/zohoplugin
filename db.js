// Postgres persistence. Everything that used to live in memory lives here, so a
// restart or redeploy no longer invalidates connected clients or user sessions.

import pg from "pg";

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
  ssl: useSsl() ? { rejectUnauthorized: false } : false,
  max: 5,
});

pool.on("error", (err) => console.error("[db] idle client error:", err.message));

export async function migrate() {
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
  `);

  // Opportunistic cleanup of anything already expired.
  await pool
    .query(
      `DELETE FROM pending_auth WHERE expires_at < now();
       DELETE FROM oauth_codes  WHERE expires_at < now();
       DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at < now();`
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
      u.refreshToken,
      u.accountsServer,
      u.apiDomain,
      u.defaultOrgId ?? null,
    ]
  );
  return rows[0];
}

export async function getUser(id) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
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
  return rows[0]?.metadata ?? undefined;
}

export async function saveClient(metadata) {
  await pool.query(
    `INSERT INTO oauth_clients (client_id, metadata) VALUES ($1,$2)
     ON CONFLICT (client_id) DO UPDATE SET metadata = EXCLUDED.metadata`,
    [metadata.client_id, metadata]
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
    [token, kind, clientId, userId, scopes ?? [], resource ?? null, ttlMs ?? null]
  );
}

export async function getToken(token) {
  const { rows } = await pool.query(
    `SELECT * FROM oauth_tokens
     WHERE token = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [token]
  );
  return rows[0] ?? null;
}

export async function deleteToken(token) {
  await pool.query(`DELETE FROM oauth_tokens WHERE token = $1`, [token]);
}

export async function close() {
  await pool.end();
}

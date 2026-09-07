// Pre-flight check: verifies configuration and lists linked Zoho accounts.
// Run with:  npm run check

import tools from "./tools.js";
import * as db from "./db.js";

console.log(`\nTools defined     : ${tools.length}`);
console.log(`Public URL        : ${process.env.PUBLIC_URL || "(not set)"}`);
console.log(`Zoho callback URI : ${(process.env.PUBLIC_URL || "").replace(/\/+$/, "")}/zoho/callback`);
console.log(`Allowed domains   : ${process.env.ALLOWED_EMAIL_DOMAINS || "(any)"}\n`);

const missing = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "PUBLIC_URL", "DATABASE_URL", "TOKEN_ENCRYPTION_KEY"].filter(
  (k) => !process.env[k]
);
if (missing.length) {
  console.error(`FAILED — missing environment variables: ${missing.join(", ")}\n`);
  process.exit(1);
}

try {
  await db.health();
  console.log("Database          : connected (read-only check; startup performs migrations)\n");

  const users = await db.listUsers();
  if (!users.length) {
    console.log("No Zoho accounts linked yet.");
    console.log("Each person links their own by connecting the app in ChatGPT.\n");
  } else {
    console.log(`Linked accounts (${users.length}):`);
    for (const u of users) {
      console.log(`  ${u.email ?? u.id}  org=${u.default_org_id ?? "none"}  since ${u.created_at.toISOString().slice(0, 10)}`);
    }
    console.log("");
  }
  await db.close();
} catch (err) {
  console.error(`FAILED — ${err.message}\n`);
  process.exit(1);
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const READ_ONLY = process.env.ZOHO_READ_ONLY?.toLowerCase() !== "false";
export const VERSION = "3.0.0";
export const BUILD_ID = process.env.BUILD_ID || "development";
export function integerSetting(name, fallback, min = 1, max = 1000000) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
export function tokenHash(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
function encryptionKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error("TOKEN_ENCRYPTION_KEY must contain 64 hexadecimal characters");
  return Buffer.from(hex, "hex");
}
export function validateEncryptionKey() { encryptionKey(); }
export function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["enc:v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}
export function decrypt(value) {
  if (!value.startsWith("enc:v1:")) throw new Error("Unmigrated encrypted value");
  const [, , iv, tag, ciphertext] = value.split(":");
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  cipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([cipher.update(Buffer.from(ciphertext, "base64")), cipher.final()]).toString("utf8");
}
// Exact origins only: no credentials, paths, alternate ports, or redirects.
const REGIONS = ["com", "eu", "in", "com.au", "jp", "ca", "sa", "com.cn", "uk"];
export function zohoOrigin(value, kind = "accounts") {
  const url = new URL(value);
  const hosts = REGIONS.map(region => kind === "accounts" ? `accounts.zoho.${region}` : `www.zohoapis.${region}`);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash || !hosts.includes(url.hostname)) {
    throw new Error("Untrusted Zoho endpoint");
  }
  return url.origin;
}

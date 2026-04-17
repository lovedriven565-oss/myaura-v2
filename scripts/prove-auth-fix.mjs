/**
 * Ad-hoc proof script for the initData HMAC fix.
 *
 * Simulates exactly what Telegram does on their side:
 *   1. Take user payload as JSON string.
 *   2. URL-encode values into an initData-style query string.
 *   3. Compute the HMAC over the DECODED data_check_string (Telegram spec).
 *   4. Verify that:
 *      a) the OLD implementation (HMAC over raw/encoded) FAILS.
 *      b) the NEW implementation (HMAC over decoded, with raw fallback) PASSES.
 *
 * Run: node scripts/prove-auth-fix.mjs
 */
import crypto from "crypto";

const BOT_TOKEN = "1234567890:TEST_TOKEN_FOR_PROOF_ONLY_AAAAAAAA";

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}
function hmacHex(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

// Build an initData string the way Telegram client does.
// Sorted DOESN'T matter for the query string, but matters for the check.
const user = { id: 123456789, first_name: "Петя", username: "petya" };
const authDate = Math.floor(Date.now() / 1000);
const queryId = "AAH_test_query_id_12345";

const fields = {
  auth_date: String(authDate),
  query_id: queryId,
  user: JSON.stringify(user),
};

// The signer (Telegram) computes HMAC over DECODED data_check_string.
const secret = hmacSha256("WebAppData", BOT_TOKEN);
const dcsDecoded = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join("\n");
const signedHash = hmacHex(secret, dcsDecoded);

// Then it URL-encodes values into the query string sent to the WebApp.
const initData =
  Object.keys(fields).map(k => `${k}=${encodeURIComponent(fields[k])}`).join("&")
  + `&hash=${signedHash}`;

console.log("=== Simulated Telegram initData ===");
console.log("initData length:", initData.length);
console.log("signed hash (first 8):", signedHash.slice(0, 8));

// ---------- OLD implementation (raw/encoded) ----------
function validateOld(raw) {
  const pairs = raw.split("&");
  const params = {};
  let h = null;
  for (const p of pairs) {
    const i = p.indexOf("=");
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    if (k === "hash") h = v;
    else params[k] = v;
  }
  const dcs = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("\n");
  const calc = hmacHex(secret, dcs);
  return { ok: calc === h, calc: calc.slice(0, 8), received: h.slice(0, 8) };
}

// ---------- NEW implementation (tries both) ----------
function validateNew(raw) {
  const pairs = raw.split("&");
  const paramsRaw = {}, paramsDecoded = {};
  let h = null;
  for (const p of pairs) {
    const i = p.indexOf("=");
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    if (k === "hash") { h = v; continue; }
    paramsRaw[k] = v;
    paramsDecoded[k] = decodeURIComponent(v);
  }
  const dcsDecoded = Object.keys(paramsDecoded).sort().map(k => `${k}=${paramsDecoded[k]}`).join("\n");
  const dcsRaw = Object.keys(paramsRaw).sort().map(k => `${k}=${paramsRaw[k]}`).join("\n");
  const calcDecoded = hmacHex(secret, dcsDecoded);
  const calcRaw = hmacHex(secret, dcsRaw);
  const matched =
    calcDecoded === h ? "decoded" :
    calcRaw === h ? "raw" :
    null;
  return {
    ok: matched !== null,
    matched,
    calcDecoded: calcDecoded.slice(0, 8),
    calcRaw: calcRaw.slice(0, 8),
    received: h.slice(0, 8),
  };
}

console.log("\n=== OLD validation (raw/encoded values in DCS) ===");
console.log(validateOld(initData));

console.log("\n=== NEW validation (both strategies) ===");
console.log(validateNew(initData));

console.log("\n=== Verdict ===");
const oldR = validateOld(initData);
const newR = validateNew(initData);
if (!oldR.ok && newR.ok && newR.matched === "decoded") {
  console.log("✅ PROVEN: old impl rejects Telegram-signed payload; new impl accepts via 'decoded' strategy.");
  process.exit(0);
} else {
  console.log("❌ Proof did NOT hold as expected.");
  console.log({ oldR, newR });
  process.exit(1);
}

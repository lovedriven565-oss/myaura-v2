/**
 * End-to-end test for POST /api/upload-urls + R2 direct upload.
 *
 * Flow:
 *   1. Generate a tiny fake JPEG buffer (valid magic bytes).
 *   2. POST /api/upload-urls to mint presigned URLs.
 *   3. PUT the buffer to the first presigned URL.
 *   4. HEAD the public R2 URL (if R2_PUBLIC_BASE_URL is set) to confirm upload.
 *   5. Report success/failure of each stage.
 *
 * Run:
 *   node scripts/test-presigned-upload.mjs \
 *     --api=https://myaura.by \
 *     --init-data="query_id=...&user=...&auth_date=...&hash=..."
 *
 * Or via env:
 *   API_URL=https://myaura.by INIT_DATA='...' node scripts/test-presigned-upload.mjs
 */

// ─── Args / env ─────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter(a => a.startsWith("--"))
    .map(a => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=")];
    })
);

const API_URL = args.api || process.env.API_URL || "https://myaura.by";
const INIT_DATA = args["init-data"] || process.env.INIT_DATA;
const PACKAGE_ID = args.package || "starter";
const FILE_COUNT = parseInt(args.count || "2", 10);

if (!INIT_DATA) {
  console.error("❌ Missing initData.");
  console.error("   Provide via --init-data='...' or INIT_DATA env var.");
  console.error("   Get it from DevTools console in Telegram Mini App:");
  console.error("     Telegram.WebApp.initData");
  process.exit(1);
}

// ─── Tiny fake JPEG (valid magic bytes + a few filler bytes) ────────────────
// Real test files could be loaded from disk; this keeps the script dependency-free.
function makeFakeJpeg(sizeBytes = 1024) {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const footer = Buffer.from([0xff, 0xd9]);
  const filler = Buffer.alloc(Math.max(0, sizeBytes - header.length - footer.length), 0x20);
  return Buffer.concat([header, filler, footer]);
}

// ─── Step 1: mint presigned URLs ────────────────────────────────────────────
async function mintPresignedUrls() {
  const files = Array.from({ length: FILE_COUNT }, (_, i) => ({
    name: `test-${i + 1}.jpg`,
    size: 1024 * (i + 1), // 1KB, 2KB, ...
    contentType: "image/jpeg",
  }));

  console.log(`\n━━━ Stage 1: POST ${API_URL}/api/upload-urls ━━━`);
  console.log(`    packageId=${PACKAGE_ID}, files=${files.length}`);

  const res = await fetch(`${API_URL}/api/upload-urls`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Init-Data": INIT_DATA,
    },
    body: JSON.stringify({ packageId: PACKAGE_ID, files }),
  });

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    console.error(`❌ HTTP ${res.status} ${res.statusText}`);
    console.error("   Response:", JSON.stringify(payload, null, 2));
    throw new Error("Presign request failed");
  }

  console.log(`✓ HTTP ${res.status}, got ${payload.uploads?.length ?? 0} presigned URL(s)`);
  console.log(`  First key: ${payload.uploads?.[0]?.key}`);
  console.log(`  TTL: ${payload.ttlSec}s`);
  return { slots: payload.uploads, files };
}

// ─── Step 2: PUT a fake JPEG to the first presigned URL ─────────────────────
async function uploadToR2(slot, buffer) {
  console.log(`\n━━━ Stage 2: PUT ${new URL(slot.url).host}${new URL(slot.url).pathname} ━━━`);
  console.log(`    size=${buffer.length} bytes, headers=${JSON.stringify(slot.headers)}`);

  // Content-Length MUST match what we declared; presigned signature enforces it.
  const res = await fetch(slot.url, {
    method: "PUT",
    headers: slot.headers,
    body: buffer,
  });

  const body = await res.text();
  if (!res.ok) {
    console.error(`❌ HTTP ${res.status} ${res.statusText}`);
    console.error("   Response body:", body.slice(0, 500));
    throw new Error("R2 upload failed");
  }

  console.log(`✓ HTTP ${res.status} — R2 accepted the PUT`);
  console.log(`  ETag: ${res.headers.get("etag") || "(none)"}`);
}

// ─── Step 3: HEAD the public R2 URL if configured (optional sanity) ─────────
async function checkPublicUrl(slot) {
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!publicBase) {
    console.log("\n━━━ Stage 3: Public HEAD skipped (R2_PUBLIC_BASE_URL not set) ━━━");
    return;
  }
  const url = `${publicBase.replace(/\/$/, "")}/${slot.key}`;
  console.log(`\n━━━ Stage 3: HEAD ${url} ━━━`);
  const res = await fetch(url, { method: "HEAD" });
  console.log(`  HTTP ${res.status}, content-length=${res.headers.get("content-length")}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    const { slots, files } = await mintPresignedUrls();
    if (!slots || slots.length === 0) throw new Error("No slots returned");

    // Test: upload to the FIRST slot only (enough to prove the signature works)
    const firstSlot = slots[0];
    const buffer = makeFakeJpeg(files[0].size);
    // Pad/truncate to match declared size exactly
    const finalBuffer = Buffer.alloc(files[0].size);
    buffer.copy(finalBuffer, 0, 0, Math.min(buffer.length, finalBuffer.length));
    finalBuffer[0] = 0xff;
    finalBuffer[1] = 0xd8;
    finalBuffer[2] = 0xff;

    await uploadToR2(firstSlot, finalBuffer);
    await checkPublicUrl(firstSlot);

    console.log("\n🎉 END-TO-END SUCCESS");
    console.log(`   Uploaded key: ${firstSlot.key}`);
    console.log(`   Remaining ${slots.length - 1} slot(s) were minted but not used.`);
    console.log("\n⚠️  Don't forget: this leaves test file(s) in R2 until retention cron cleans them.");
  } catch (err) {
    console.error("\n💥 TEST FAILED:", err.message);
    process.exit(1);
  }
})();

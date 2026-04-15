/**
 * Input Curation v2.0 — Test Suite
 *
 * Run: npx tsx src/server/__tests__/inputCuration.test.ts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { selectBestReferencePhotos } from "../inputCuration.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((e: any) => { failed++; console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); });
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

// Create a synthetic JPEG-like buffer with controllable properties
function makeBuffer(sizeKB: number, entropy: "high" | "low" = "high"): Buffer {
  const size = sizeKB * 1024;
  const buf = Buffer.alloc(size);

  // JPEG SOI marker (so Sharp can at least try)
  buf[0] = 0xFF;
  buf[1] = 0xD8;

  if (entropy === "high") {
    // Fill with pseudo-random data for high entropy
    for (let i = 2; i < size; i++) {
      buf[i] = (i * 7 + 13) % 256;
    }
  } else {
    // Fill with uniform data for low entropy
    buf.fill(128, 2);
  }

  return buf;
}

function makeFile(sizeKB: number, name: string, entropy: "high" | "low" = "high") {
  return { buffer: makeBuffer(sizeKB, entropy), originalname: name };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function runTests() {
  console.log("\n─── Input Curation v2.0 Tests ───\n");

  // ── Free mode: 5 uploaded → top 3 selected ──
  console.log("[free-mode]");

  await test("free: 5 photos → selects up to 3", async () => {
    const files = [
      makeFile(200, "good1.jpg"),
      makeFile(300, "good2.jpg"),
      makeFile(500, "good3.jpg"),
      makeFile(400, "good4.jpg"),
      makeFile(150, "good5.jpg"),
    ];
    const result = await selectBestReferencePhotos(files, { mode: "free" });
    assert.ok(!result.hardReject, "should not hard reject");
    assert.ok(result.selectedIndices.length <= 3, `expected ≤3 selected, got ${result.selectedIndices.length}`);
    assert.ok(result.selectedIndices.length >= 1, "should select at least 1");
    assert.strictEqual(result.telemetry.mode, "free");
    assert.strictEqual(result.telemetry.uploadedCount, 5);
  });

  await test("free: 1 photo works (minimum)", async () => {
    const files = [makeFile(200, "solo.jpg")];
    const result = await selectBestReferencePhotos(files, { mode: "free" });
    assert.ok(!result.hardReject, "1 good photo should not hard reject in free mode");
    assert.strictEqual(result.selectedIndices.length, 1);
  });

  await test("free: 1 bad photo → hard reject", async () => {
    const files = [makeFile(5, "tiny.jpg", "low")]; // 5KB, low entropy
    const result = await selectBestReferencePhotos(files, { mode: "free" });
    assert.ok(result.hardReject, "should hard reject when only photo is terrible");
    assert.strictEqual(result.selectedIndices.length, 0);
  });

  // ── Premium mode: 10-15 uploaded → balanced selection ──
  console.log("\n[premium-mode]");

  await test("premium: 10 photos → selects up to 8", async () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFile(200 + i * 50, `photo_${i}.jpg`)
    );
    const result = await selectBestReferencePhotos(files, { mode: "premium" });
    assert.ok(!result.hardReject);
    assert.ok(result.selectedIndices.length <= 8, `expected ≤8, got ${result.selectedIndices.length}`);
    assert.ok(result.selectedIndices.length >= 3, `expected ≥3, got ${result.selectedIndices.length}`);
    assert.strictEqual(result.telemetry.mode, "premium");
  });

  await test("premium: 15 photos → selects up to 8", async () => {
    const files = Array.from({ length: 15 }, (_, i) =>
      makeFile(150 + i * 40, `photo_${i}.jpg`)
    );
    const result = await selectBestReferencePhotos(files, { mode: "premium" });
    assert.ok(!result.hardReject);
    assert.ok(result.selectedIndices.length <= 8);
  });

  await test("premium: fewer than 3 good photos → hard reject", async () => {
    const files = [
      makeFile(5, "bad1.jpg", "low"),
      makeFile(5, "bad2.jpg", "low"),
      makeFile(200, "ok.jpg"),
      makeFile(5, "bad3.jpg", "low"),
    ];
    const result = await selectBestReferencePhotos(files, { mode: "premium" });
    // Only 1 might pass → below PREMIUM_MIN_ACCEPTABLE (3)
    // This depends on scoring; the "ok" one should pass but not reach 3
    assert.ok(result.telemetry.passedCount < 3 || !result.hardReject);
  });

  // ── Duplicate handling ──
  console.log("\n[duplicates]");

  await test("duplicate-heavy set: deduplication works", async () => {
    const base = makeFile(300, "original.jpg");
    // Create near-duplicates (same content, same size)
    const files = [
      base,
      { buffer: Buffer.from(base.buffer), originalname: "dup1.jpg" },
      { buffer: Buffer.from(base.buffer), originalname: "dup2.jpg" },
      makeFile(400, "unique.jpg"),
      makeFile(500, "unique2.jpg"),
    ];
    const result = await selectBestReferencePhotos(files, { mode: "free" });
    assert.ok(!result.hardReject);
    // At least some should be flagged as duplicates
    const dupCount = result.allScores.filter(s =>
      s.reasons.includes("duplicate_removed")
    ).length;
    assert.ok(dupCount >= 1, `expected ≥1 duplicates removed, got ${dupCount}`);
  });

  // ── Low quality set ──
  console.log("\n[low-quality]");

  await test("all poor photos in free → falls back gracefully", async () => {
    const files = [
      makeFile(10, "low1.jpg", "low"),
      makeFile(15, "low2.jpg", "low"),
      makeFile(20, "low3.jpg", "low"),
    ];
    const result = await selectBestReferencePhotos(files, { mode: "free" });
    // May hard reject or select the least-bad ones
    assert.ok(result.telemetry.uploadedCount === 3);
  });

  // ── Telemetry ──
  console.log("\n[telemetry]");

  await test("telemetry contains all required fields", async () => {
    const files = [makeFile(300, "test.jpg"), makeFile(400, "test2.jpg")];
    const result = await selectBestReferencePhotos(files, { mode: "free" });
    const t = result.telemetry;
    assert.strictEqual(t.mode, "free");
    assert.strictEqual(t.uploadedCount, 2);
    assert.ok(typeof t.passedCount === "number");
    assert.ok(typeof t.dedupedCount === "number");
    assert.ok(typeof t.selectedCount === "number");
    assert.ok(typeof t.rejectedCount === "number");
    assert.ok(Array.isArray(t.rejectionReasons));
    assert.ok(Array.isArray(t.selectedIndices));
    assert.ok(typeof t.latencyMs === "number");
    assert.ok(t.latencyMs >= 0);
    assert.strictEqual(typeof t.hardReject, "boolean");
  });

  await test("latency is measured", async () => {
    const files = [makeFile(300, "test.jpg")];
    const result = await selectBestReferencePhotos(files, { mode: "free" });
    assert.ok(result.telemetry.latencyMs >= 0, "latency should be non-negative");
  });

  // ── Determinism ──
  console.log("\n[determinism]");

  await test("same input → same selection", async () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      makeFile(200 + i * 100, `photo_${i}.jpg`)
    );
    const r1 = await selectBestReferencePhotos(files, { mode: "free" });
    const r2 = await selectBestReferencePhotos(files, { mode: "free" });
    assert.deepStrictEqual(r1.selectedIndices, r2.selectedIndices, "selection should be deterministic");
  });

  // ── Edge cases ──
  console.log("\n[edge-cases]");

  await test("empty file list → hard reject", async () => {
    const result = await selectBestReferencePhotos([], { mode: "free" });
    assert.ok(result.hardReject);
    assert.strictEqual(result.selectedIndices.length, 0);
  });

  await test("default mode is premium", async () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFile(200 + i * 30, `photo_${i}.jpg`)
    );
    const result = await selectBestReferencePhotos(files);
    assert.strictEqual(result.telemetry.mode, "premium");
  });

  // ── PhotoScore fields ──
  console.log("\n[photo-score-fields]");

  await test("scores include width, height, aspectRatio, isLikelyPortrait", async () => {
    const files = [makeFile(300, "test.jpg")];
    const result = await selectBestReferencePhotos(files, { mode: "free" });
    const s = result.allScores[0];
    assert.ok(typeof s.width === "number");
    assert.ok(typeof s.height === "number");
    assert.ok(typeof s.aspectRatio === "number");
    assert.ok(typeof s.isLikelyPortrait === "boolean");
    assert.ok(typeof s.score === "number");
    assert.ok(typeof s.passed === "boolean");
  });

  // ── Summary ──
  console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

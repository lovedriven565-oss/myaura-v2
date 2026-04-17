/**
 * Live end-to-end proof: upload → get → delete against real R2 using the
 * EXACT same client config the server uses.
 *
 * Uses credentials from process.env (loaded from local .env by the --env-file
 * flag when run). Fails loudly with the raw SDK error if anything breaks —
 * this is exactly what the operator needs to see when NoSuchBucket hits.
 *
 * Run:  node --env-file=.env scripts/prove-r2-fix.mjs
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME;
const endpoint = process.env.R2_S3_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;

console.log(`[proof] endpoint=${endpoint}`);
console.log(`[proof] bucket=${bucket}`);
console.log(`[proof] pathStyle=true`);

const s3 = new S3Client({
  region: "auto",
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

const key = `proof/_selfcheck_${Date.now()}.txt`;
const body = Buffer.from("myaura r2 client proof OK\n");

async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

try {
  console.log("\n[1/4] HeadBucket (does bucket exist for this endpoint?)");
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log("      ✅ bucket reachable");

  console.log("\n[2/4] PutObject");
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain" }));
  console.log(`      ✅ uploaded ${key} (${body.length}B)`);

  console.log("\n[3/4] GetObject");
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await streamToString(got.Body);
  console.log(`      ✅ downloaded ${text.length}B -> "${text.trim()}"`);

  console.log("\n[4/4] DeleteObject");
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  console.log("      ✅ deleted");

  console.log("\n=== R2 path proven: upload/get/delete all OK ===");
  process.exit(0);
} catch (err) {
  console.error("\n❌ R2 proof FAILED");
  console.error(`    name   : ${err.name}`);
  console.error(`    code   : ${err.Code || err.$metadata?.httpStatusCode}`);
  console.error(`    msg    : ${err.message}`);
  console.error(`    host   : ${err.$response?.config?.endpoint || endpoint}`);
  console.error(`    reqId  : ${err.$metadata?.requestId}`);
  process.exit(1);
}

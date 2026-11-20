import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [manifestPath, targetRoot, concurrencyArg] = process.argv.slice(2);
if (!manifestPath || !targetRoot) {
  throw new Error('Usage: fetch-resource-store <data/resources.json> <store-directory> [concurrency]');
}
const concurrency = Math.max(1, Math.min(12, Number(concurrencyArg) || 8));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const items = [];
const seen = new Set();
for (const course of manifest.courses) {
  for (const file of course.files) {
    if (seen.has(file.storageKey)) continue;
    seen.add(file.storageKey);
    items.push({ ...file, repository: course.repositoryName });
  }
}
await mkdir(targetRoot, { recursive: true, mode: 0o700 });

let cursor = 0;
let completed = 0;
const failures = [];
async function existsCorrect(file) {
  try {
    const info = await stat(join(targetRoot, file.storageKey));
    return info.isFile() && info.size === file.sizeBytes;
  } catch { return false; }
}
async function fetchCandidate(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(900_000), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== file.sizeBytes) throw new Error(`size mismatch ${buffer.length}/${file.sizeBytes}`);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== file.sha256) throw new Error('sha256 mismatch');
  const temp = join(targetRoot, `${file.storageKey}.part`);
  await writeFile(temp, buffer, { mode: 0o600 });
  await rename(temp, join(targetRoot, file.storageKey));
}
async function download(file) {
  if (await existsCorrect(file)) return;
  const encoded = file.sourcePath.split('/').map(encodeURIComponent).join('/');
  const urls = [
    `https://cdn.jsdelivr.net/gh/${file.repository}@main/${encoded}`,
    `https://gh-proxy.com/https://raw.githubusercontent.com/${file.repository}/main/${encoded}`,
  ];
  let lastError;
  for (const url of urls) {
    try {
      await fetchCandidate(url, file);
      return;
    } catch (error) {
      lastError = error;
      await unlink(join(targetRoot, `${file.storageKey}.part`)).catch(() => undefined);
    }
  }
  throw lastError ?? new Error('download failed');
}
async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= items.length) return;
    const file = items[index];
    try { await download(file); }
    catch (error) { failures.push({ id: file.id, error: String(error?.message ?? error) }); }
    completed += 1;
    if (completed % 10 === 0 || completed === items.length) console.log(`progress ${completed}/${items.length} failures=${failures.length}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
if (failures.length) {
  console.error(JSON.stringify({ files: items.length, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, files: items.length, directory: targetRoot }));
}

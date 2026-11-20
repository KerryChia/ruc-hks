import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '../../../../src/db';
import { getResourceFile } from '../../../../src/domains/resources';
import { checkRateLimit, rateLimitHeaders } from '../../../../src/rate-limit';
import { currentUser, readResult } from '../../../_lib/web';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const resourceRoot = process.env.RESOURCE_DIR ?? '/var/lib/examhub/resources';
const inlineExtensions = new Set(['pdf', 'md', 'txt', 'cpp', 'h', 'ipynb', 'csv', 'py']);

function disposition(title: string, extension: string, inline: boolean) {
  const fullName = `${title}.${extension}`;
  const ascii = `resource-${Date.now().toString(36)}.${extension}`;
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fullName)}`;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ code: 'UNAUTHENTICATED', message: '请先登录校园账户。' }, { status: 401 });

  const rate = checkRateLimit(request, 'resource-download', 60, 60_000);
  if (!rate.allowed) return NextResponse.json({ code: 'RATE_LIMITED', message: '下载过于频繁，请稍后再试。' }, {
    status: 429, headers: { 'Retry-After': String(rate.retryAfter), ...rateLimitHeaders(rate) },
  });

  const { id } = await params;
  const result = await readResult(async () => getResourceFile(await getDb(), id));
  if (!result.ok) return NextResponse.json(result.error, { status: 404 });
  const file = result.value;
  if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(file.storageKey)) return NextResponse.json({ code: 'NOT_FOUND', message: '文件不可用。' }, { status: 404 });
  const fullPath = path.resolve(/* turbopackIgnore: true */ resourceRoot, file.storageKey);
  if (!fullPath.startsWith(path.resolve(/* turbopackIgnore: true */ resourceRoot) + path.sep)) return NextResponse.json({ code: 'NOT_FOUND', message: '文件不可用。' }, { status: 404 });

  let info;
  try { info = await stat(/* turbopackIgnore: true */ fullPath); } catch { return NextResponse.json({ code: 'FILE_MISSING', message: '文件暂不可用。' }, { status: 404 }); }
  if (!info.isFile()) return NextResponse.json({ code: 'NOT_FOUND', message: '文件不可用。' }, { status: 404 });

  const headers = new Headers({
    'Content-Type': file.mime,
    'Content-Disposition': disposition(file.title, file.extension, inlineExtensions.has(file.extension)),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    ...rateLimitHeaders(rate),
  });

  const range = request.headers.get('range');
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (!match[1] && !match[2])) {
      headers.set('Content-Range', `bytes */${info.size}`);
      return new NextResponse(null, { status: 416, headers });
    }
    if (!match[1]) {
      start = Math.max(0, info.size - Number(match[2]));
    } else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      headers.set('Content-Range', `bytes */${info.size}`);
      return new NextResponse(null, { status: 416, headers });
    }
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
  }
  headers.set('Content-Length', String(end - start + 1));

  const stream = createReadStream(/* turbopackIgnore: true */ fullPath, { start, end });
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status, headers });
}

import { getDb } from '../../../src/db';

export const runtime = 'nodejs';

export async function GET() {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    await (await getDb()).query('select 1');
    return Response.json({ ok: true }, { headers });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers });
  }
}

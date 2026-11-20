import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getDb } from '../../../src/db';
import { abortAsk, buildAskUser, finishAsk, prepareAsk, sanitizeHistory, systemPrompt } from '../../../src/domains/ai-ask';
import { chatStream } from '../../../src/domains/ai/provider';
import { resolveSession } from '../../../src/domains/identity';
import { checkRateLimit, rateLimitHeaders } from '../../../src/rate-limit';
import { SESSION_COOKIE } from '../../_lib/presentation';
import { publicProblem } from '../../_lib/web';

export const dynamic = 'force-dynamic';

// Per-question AI assistant: an authenticated SSE stream bound to an open attempt.
// No model names or provider details ever reach the client.
export async function POST(request: NextRequest) {
  const rate = checkRateLimit(request, 'ask', 8, 10_000);
  if (!rate.allowed) {
    return NextResponse.json({ code: 'RATE_LIMITED', message: '提问过于频繁，请稍后再试。' }, {
      status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(rate.retryAfter), ...rateLimitHeaders(rate) },
    });
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = token ? await resolveSession(await getDb(), token) : null;
  if (!user) return NextResponse.json({ code: 'UNAUTHENTICATED', message: '请先登录，再向 AI 助教提问。' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  let body: { attemptId?: unknown; questionId?: unknown; text?: unknown; history?: unknown };
  try { body = await request.json() as typeof body; } catch { return NextResponse.json({ code: 'BAD_REQUEST', message: '请求格式不正确。' }, { status: 400 }); }
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
  const questionId = typeof body.questionId === 'string' ? body.questionId : '';
  const text = typeof body.text === 'string' ? body.text : '';
  const history = sanitizeHistory(body.history);
  if (!/^[\w-]{1,128}$/.test(attemptId) || !/^[\w-]{1,128}$/.test(questionId)) {
    return NextResponse.json({ code: 'BAD_REQUEST', message: '请求格式不正确。' }, { status: 400 });
  }
  const db = await getDb();
  let plan;
  try {
    plan = await prepareAsk(db, user.id, attemptId, questionId, text, history);
  } catch (error) {
    const problem = publicProblem(error);
    return NextResponse.json(problem, { status: problem.code === 'ASK_DAILY_LIMIT' ? 429 : 400, headers: { 'Cache-Control': 'no-store' } });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (payload: Record<string, unknown>) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); }
        catch { open = false; }
      };
      try {
        const result = await chatStream(
          { system: systemPrompt, user: buildAskUser(plan), history: plan.history, maxTokens: 1200 },
          delta => send({ type: 'content', text: delta }),
        );
        await finishAsk(db, user.id, plan, result);
        send({ type: 'done' });
      } catch (error) {
        await abortAsk(db, user.id, plan);
        const problem = publicProblem(error);
        send({ type: 'error', text: problem.message });
      } finally {
        open = false;
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

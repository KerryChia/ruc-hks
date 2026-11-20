import { fail } from '../../errors';

// The upstream is OpenAI-compatible. Credentials and hostnames live only in the server
// environment; nothing here is imported by a client component and nothing is logged.
const ALLOWED_MODELS = ['gpt-6-luna', 'step-5-preview'] as const;
export type AiModel = (typeof ALLOWED_MODELS)[number];

export function aiEnabled() {
  return Boolean(process.env.AI_API_KEY && process.env.AI_API_BASE);
}

export function selectedModel(): AiModel {
  const wanted = process.env.AI_MODEL;
  return ALLOWED_MODELS.includes(wanted as AiModel) ? wanted as AiModel : ALLOWED_MODELS[0];
}

type ChatResponse = {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

type StreamChunk = {
  choices?: { delta?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// Streaming chat for the per-question assistant: calls onDelta for each content
// chunk and resolves with the full text plus authoritative usage when available.
export async function chatStream(
  input: { system: string; user: string; history: { role: 'user' | 'assistant'; content: string }[]; maxTokens: number },
  onDelta: (text: string) => void,
) {
  if (!aiEnabled()) fail('AI_DISABLED', 'AI 助教尚未启用。');
  const base = (process.env.AI_API_BASE ?? '').replace(/\/+$/, '');
  const key = process.env.AI_API_KEY!;
  const model = selectedModel();
  const timeout = Number(process.env.AI_TIMEOUT_MS ?? 45000);
  let response: Response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(Number.isFinite(timeout) ? timeout : 45000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: input.system },
          ...input.history,
          { role: 'user', content: input.user },
        ],
        max_tokens: input.maxTokens,
        temperature: 0.3,
        stream: true,
      }),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      fail('AI_TIMEOUT', 'AI 助教响应超时，请稍后重试。');
    }
    fail('AI_UPSTREAM', 'AI 助教暂时不可用，请稍后重试。');
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    fail('AI_UPSTREAM', 'AI 助教暂时不可用，请稍后重试。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let sawChunk = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk: StreamChunk;
          try { chunk = JSON.parse(payload) as StreamChunk; } catch { continue; }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) { sawChunk = true; text += delta; onDelta(delta); }
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      fail('AI_TIMEOUT', 'AI 助教响应超时，请稍后重试。');
    }
    fail('AI_UPSTREAM', 'AI 助教连接中断，请稍后重试。');
  }
  if (!sawChunk || !text.trim()) fail('AI_EMPTY', 'AI 助教没有返回内容，请重试。');
  return {
    text: text.trim(),
    inputTokens: inputTokens || Math.ceil((input.system.length + input.user.length + input.history.reduce((sum, m) => sum + m.content.length, 0)) / 1.2),
    outputTokens: outputTokens || Math.ceil(text.length / 1.2),
  };
}

export async function chat(input: { system: string; user: string; maxTokens: number }) {
  if (!aiEnabled()) fail('AI_DISABLED', '讲评服务尚未启用。');
  const base = (process.env.AI_API_BASE ?? '').replace(/\/+$/, '');
  const key = process.env.AI_API_KEY!;
  const model = selectedModel();
  const timeout = Number(process.env.AI_TIMEOUT_MS ?? 45000);
  let response: Response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(Number.isFinite(timeout) ? timeout : 45000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        max_tokens: input.maxTokens,
        temperature: 0.3,
        stream: false,
      }),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      fail('AI_TIMEOUT', '讲评生成超时，请稍后重试。');
    }
    fail('AI_UPSTREAM', '讲评服务暂时不可用，请稍后重试。');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    fail('AI_UPSTREAM', '讲评服务暂时不可用，请稍后重试。');
  }
  let data: ChatResponse;
  try { data = await response.json() as ChatResponse; }
  catch { fail('AI_UPSTREAM', '讲评服务返回了无法解析的内容。'); }
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) fail('AI_EMPTY', '讲评内容为空，请重试。');
  // Upstream usage is authoritative; fall back to a conservative estimate if it is missing.
  const inputTokens = Number.isInteger(data.usage?.prompt_tokens) ? data.usage!.prompt_tokens! : Math.ceil((input.system.length + input.user.length) / 1.2);
  const outputTokens = Number.isInteger(data.usage?.completion_tokens) ? data.usage!.completion_tokens! : Math.ceil(text.length / 1.2);
  return { text, inputTokens, outputTokens, model };
}

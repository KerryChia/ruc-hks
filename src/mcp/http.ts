import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getDb } from '../db';
import { resolveHandoff } from '../domains/handoff';
import { resolveMcpToken } from '../domains/identity';
import { checkRateLimit, rateLimitHeaders } from '../rate-limit';
import { createHandoffMcp } from './handoff-server';
import { createMcp } from './server';

function errorResponse(status: number, message: string, headers?: Record<string, string>) {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

function acceptsOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true; // Native clients do not send Origin.
  const url = new URL(request.url);
  const configuredOrigin = process.env.EXAMHUB_MCP_ORIGIN;
  if (configuredOrigin) return origin === configuredOrigin;
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && origin === url.origin;
}

// The UI can mount this in its Node process. Two kinds of bearer credential are accepted:
// long-lived account tokens (scoped by the user) and one-time handoff codes created on a
// pack page, which mount a much smaller server bound to a single pack and CC budget.
// Neither uses UI cookies, and neither implements OAuth.
export async function handleMcp(request: Request): Promise<Response> {
  if (!acceptsOrigin(request)) return errorResponse(403, 'Origin not allowed.');
  if (request.method !== 'POST') return errorResponse(405, 'Only POST is supported.', { Allow: 'POST' });

  const rate = checkRateLimit(request, 'mcp', 30, 10_000);
  if (!rate.allowed) return errorResponse(429, 'Too many requests. Retry later.', {
    'Retry-After': String(rate.retryAfter),
    ...rateLimitHeaders(rate),
  });

  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.length <= 512 && /^Bearer +([A-Za-z0-9._~+/\-]+=*)$/i.exec(authorization)?.[1];
  const unauthorized = () => errorResponse(401, 'A valid ExamHub MCP token is required.', { 'WWW-Authenticate': 'Bearer' });
  if (!token) return unauthorized();

  try {
    const db = getDb();
    const identity = await resolveMcpToken(db, token);
    const handoff = identity ? null : await resolveHandoff(db, token);
    if (!identity && !handoff) return unauthorized();

    const server = identity ? createMcp(db, identity.userId, identity.scopes) : createHandoffMcp(db, handoff!);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 256 * 1024,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } finally {
      await server.close();
    }
  } catch {
    return errorResponse(503, 'ExamHub MCP is temporarily unavailable.');
  }
}

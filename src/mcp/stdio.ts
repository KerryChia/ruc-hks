import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeDb, getDb } from '../db';
import { resolveMcpToken } from '../domains/identity';
import { createMcp } from './server';

function report(message: string) {
  process.stderr.write(`ExamHub MCP: ${message}\n`);
}

async function closeDatabase() {
  try {
    await closeDb();
  } catch {
    report('Could not close the database connection.');
    process.exitCode = 1;
  }
}

async function main() {
  // Supply a short-lived, manually issued MCP token in the client's environment.
  const token = process.env.EXAMHUB_MCP_TOKEN;
  if (!token) {
    report('EXAMHUB_MCP_TOKEN is required.');
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const checkAuth = () => resolveMcpToken(db, token);
  const identity = await checkAuth(); // Also verifies that the database is reachable before listening.
  if (!identity) {
    report('The MCP token is invalid, expired, or revoked.');
    process.exitCode = 1;
    await closeDatabase();
    return;
  }

  const server = createMcp(db, identity.userId, identity.scopes, checkAuth);
  server.server.onerror = () => report('Protocol error.');
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    process.stdin.off('end', shutdown);
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    try {
      await server.close();
    } catch {
      report('Could not close the MCP connection.');
      process.exitCode = 1;
    } finally {
      await closeDatabase();
    }
  };
  server.server.onclose = shutdown;
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch(async () => {
  // Connection errors may contain credentials. Never print the thrown error.
  report('Startup failed. Check the database connection and token configuration.');
  process.exitCode = 1;
  await closeDatabase();
});

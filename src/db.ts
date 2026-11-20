import { Pool } from 'pg';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Database extends Queryable {
  transaction<T>(operation: (tx: Queryable) => Promise<T>): Promise<T>;
}

async function atomic<T>(client: Queryable, operation: (tx: Queryable) => Promise<T>) {
  await client.query('begin');
  try {
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

// An embedded PostgreSQL connection services one transaction at a time.
export function createDatabase(connection: Queryable): Database {
  let queue: Promise<unknown> = Promise.resolve();
  function next<T>(work: () => Promise<T>) {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  }
  return {
    query: <T>(sql: string, params?: unknown[]) => next(() => connection.query<T>(sql, params)),
    transaction: <T>(operation: (tx: Queryable) => Promise<T>) => next(() => atomic(connection, operation))
  };
}

const shared = globalThis as typeof globalThis & { examhubPg?: Pool };

function pgClient(client: Pick<Pool, 'query'>): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params);
      return { rows: (result.rows ?? []) as T[] };
    }
  };
}

export function getDb(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = shared.examhubPg ??= new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  return {
    ...pgClient(pool),
    async transaction<T>(operation: (tx: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        return await atomic(pgClient(client), operation);
      } finally {
        client.release();
      }
    }
  };
}

export async function closeDb() {
  const pool = shared.examhubPg;
  delete shared.examhubPg;
  await pool?.end();
}

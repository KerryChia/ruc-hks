// Local development database: exposes an embedded PGlite over the Postgres wire
// protocol so `npm run db`, `scripts/import-dsa.ts` and `npm run dev` all run
// without installing a real PostgreSQL. Data persists in .pglite-dev/.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { fileURLToPath } from 'node:url';

const dataDir = fileURLToPath(new URL('../.pglite-dev', import.meta.url));
const port = Number(process.env.PGLITE_PORT ?? 54329);

const db = new PGlite(dataDir);
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
await server.start();
console.log(`PGlite wire server ready on 127.0.0.1:${port} (data: ${dataDir})`);
process.on('SIGINT', async () => { await server.stop(); await db.close(); process.exit(0); });

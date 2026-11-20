// Local development helper: create (or reset the password of) a dev account so the
// app can be exercised end-to-end without SMTP. Not used in production.
import { createHmac } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { closeDb, getDb } from '../src/db';
import { issueInvite, register } from '../src/domains/identity';

const email = process.argv[2];
const password = process.argv[3];
if (!email || !password) throw new Error('Provide a test email and password');
const code = '246810';

async function main() {
  const db = getDb();
  const secret = process.env.EMAIL_CODE_SECRET;
  if (!secret) throw new Error('EMAIL_CODE_SECRET is required');
  const invite = await issueInvite(db, email);
  const digest = createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');
  await db.query(`insert into email_codes(email,digest,issued_at,expires_at,failures,daily_issued)
    values($1,$2,now(),now()+interval '10 minutes',0,1)
    on conflict(email) do update set digest=excluded.digest, expires_at=excluded.expires_at, failures=0, daily_issued=1`, [email, digest]);
  const existing = await db.query<{ id: string }>('select id from users where email=$1', [email]);
  if (existing.rows.length) {
    const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    await db.query("update users set password_hash=$2, status='active' where email=$1", [email, passwordHash]);
    console.log(`dev account reset: ${email} / ${password}`);
    return;
  }
  const account = await register(db, { email, password, invite, code, campus: 'tongzhou' });
  console.log(`dev account ready: id ${account.id} · ${email} / ${password}`);
}

main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; }).finally(closeDb);

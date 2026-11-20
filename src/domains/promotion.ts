import type { Database, Queryable } from '../db';

// A time-boxed site-wide promotion. Rows are managed from the CLI; access checks read
// this table so ending the campaign needs no deploy.
export type Promotion = { id: string; title: string; note: string | null; startsAt: Date; endsAt: Date };

const fields = `id,title,note,starts_at as "startsAt",ends_at as "endsAt"`;

export async function activePromotion(db: Queryable): Promise<Promotion | null> {
  return (await db.query<Promotion>(`select ${fields} from promotions
    where kind='free_all' and active and starts_at<=now() and ends_at>now()
    order by ends_at desc limit 1`)).rows[0] ?? null;
}

export async function startPromotion(db: Database, days: number, title = '限时免费') {
  return db.transaction(async tx => {
    await tx.query("update promotions set active=false where kind='free_all' and active");
    const row = (await tx.query<Promotion>(`insert into promotions(kind,title,note,starts_at,ends_at,active)
      values('free_all',$1,'活动期间全部题包免费开放，课程资料免费查看与下载。',now(),now()+make_interval(days => $2::int),true)
      returning ${fields}`, [title, String(days)])).rows[0];
    return row;
  });
}

export async function stopPromotion(db: Queryable) {
  await db.query("update promotions set active=false where kind='free_all' and active");
}

export async function promotionStatus(db: Queryable) {
  const current = (await db.query<Promotion>(`select ${fields} from promotions where kind='free_all' and active
    order by ends_at desc limit 1`)).rows[0] ?? null;
  return { current, running: Boolean(current && new Date(current.endsAt).getTime() > Date.now()) };
}

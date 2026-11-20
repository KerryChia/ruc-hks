create table if not exists users (
  id uuid primary key,
  email text unique not null check (email ~ '^[a-z0-9._-]{2,32}@ruc\.edu\.cn$'),
  password_hash text not null,
  email_verified_at timestamptz,
  display_name text not null,
  campus text check (campus in ('tongzhou', 'zhongguancun', 'suzhou')),
  role text not null default 'student' check (role in ('student', 'reviewer', 'admin')),
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  created_at timestamptz not null default now()
);
create table if not exists invitations (
  token_hash text primary key, email text, expires_at timestamptz not null,
  used_at timestamptz, created_by uuid references users, used_by uuid references users,
  created_at timestamptz not null default now()
);
alter table invitations add column if not exists created_by uuid references users;
alter table invitations add column if not exists used_by uuid references users;
alter table invitations add column if not exists created_at timestamptz not null default now();
alter table invitations alter column email drop not null;
create index if not exists invitations_created_by on invitations(created_by, created_at desc);
create table if not exists email_codes (
  email text primary key, digest text not null, issued_at timestamptz not null,
  expires_at timestamptz not null, failures int not null default 0, daily_issued int not null default 1
);
create table if not exists login_limits (
  email text primary key, failures int not null, window_started timestamptz not null
);
create table if not exists sessions (
  token_hash text primary key, user_id uuid not null references users, expires_at timestamptz not null
);
create table if not exists mcp_tokens (
  token_hash text primary key, user_id uuid not null references users, scopes text[] not null,
  expires_at timestamptz not null
);
create table if not exists courses (
  id uuid primary key, code text not null, name text not null, campus text check (campus in ('tongzhou','zhongguancun','suzhou')),
  term text not null, tags text[] not null, slug text, unique(code,campus,term)
);
-- Backfill the public identifiers without replacing any existing course or pack keys.
alter table courses add column if not exists slug text;
alter table courses alter column campus drop not null;
update courses
   set slug = case id::text
     when '10000000-0000-4000-8000-000000000001' then '数据结构'
     when '10000000-0000-4000-8000-000000000002' then '概率论与数理统计'
     when '10000000-0000-4000-8000-000000000003' then '应用统计学'
     else '课程-' || id::text
   end,
   name = case when id='10000000-0000-4000-8000-000000000002' and name='概率论基础' then '概率论与数理统计' else name end
 where slug is null;
alter table courses alter column slug set not null;
create unique index if not exists courses_slug on courses(slug);
create table if not exists course_sources (
  source_key text primary key, course_id uuid not null references courses,
  source_name text not null, url text not null unique check (url like 'https://github.com/%'),
  file_count int not null check (file_count > 0)
);
create index if not exists course_sources_course on course_sources(course_id);
create table if not exists packs (
  id uuid primary key, course_id uuid not null references courses, author_id uuid references users,
  title text not null, year int not null, source_type text not null check (source_type in ('past_exam','mock','courseware','full_kit')),
  license_note text not null, starter_rank int check (starter_rank between 1 and 3),
  version int not null default 1, status text not null check (status in ('reviewing','live','rejected','delisted')),
  price_cc int not null default 8 check (price_cc >= 0), item_count int not null check (item_count > 0),
  created_at timestamptz not null default now(), unique(course_id,starter_rank)
);
create index if not exists packs_course_status on packs (course_id,status);
create table if not exists questions (
  id uuid primary key, pack_id uuid not null references packs, seq int not null check (seq > 0),
  stem text not null, options jsonb not null, answer_data text not null, tags text[] not null,
  unique(pack_id,seq)
);
create index if not exists questions_tags on questions using gin(tags);
create table if not exists permissions (
  id uuid primary key, user_id uuid not null references users, pack_id uuid not null references packs,
  license text not null check (license in ('read','practice','collection')), expires_at timestamptz,
  unique(user_id,pack_id,license)
);
create table if not exists quotes (
  id uuid primary key, user_id uuid not null references users, pack_id uuid not null references packs,
  license text not null check (license in ('read','practice','collection')), price_cc int not null check (price_cc >= 0),
  expires_at timestamptz not null, approved_at timestamptz, permission_id uuid references permissions
);
create table if not exists attempts (
  id uuid primary key, user_id uuid not null references users, pack_id uuid not null references packs,
  version int not null, mode text not null check (mode in ('paper','collection')),
  started_at timestamptz not null default now(), submitted_at timestamptz, answers jsonb,
  correct int check (correct >= 0), total int check (total > 0), score numeric(5,2),
  is_first boolean not null default false, ranked boolean not null default true
);
create unique index if not exists attempts_first on attempts(user_id,pack_id) where is_first;
create index if not exists attempts_history on attempts(user_id,pack_id,started_at desc);
create index if not exists attempts_board on attempts(pack_id,score desc) where submitted_at is not null and ranked;
create table if not exists free_opens (
  attempt_id uuid primary key references attempts, user_id uuid not null references users, pack_id uuid not null references packs,
  created_at timestamptz not null default now()
);
create index if not exists free_open_limit on free_opens(user_id,pack_id,created_at desc);
create table if not exists credit_account (
  user_id uuid not null references users, currency text not null check (currency in ('CC','RP')),
  balance int not null default 0 check (balance>=0), last_hash text not null default '',
  primary key(user_id,currency)
);
create table if not exists ledger_entry (
  id bigint generated always as identity primary key, user_id uuid not null, currency text not null,
  delta int not null check (delta <> 0), reason text not null, idem_key text not null,
  balance_after int not null check (balance_after>=0), prev_hash text not null, hash text not null,
  created_at timestamptz not null default now(), foreign key(user_id,currency) references credit_account,
  unique(user_id,currency,idem_key)
);
create index if not exists ledger_history on ledger_entry(user_id,id desc);
create or replace function examhub_append_only() returns trigger language plpgsql as $$
begin raise exception 'append-only table'; end; $$;
drop trigger if exists ledger_append_only on ledger_entry;
create trigger ledger_append_only before update or delete on ledger_entry for each row execute function examhub_append_only();
create table if not exists uploads (
  pack_id uuid primary key references packs, fingerprint text not null unique,
  reviewer_id uuid references users, reviewed_at timestamptz,
  reward_total int not null check (reward_total >= 0), released_cc int not null default 0,
  unlocks_at timestamptz, settled_at timestamptz
);
create table if not exists issue_reports (
  pack_id uuid not null references packs, user_id uuid not null references users,
  confirmed boolean not null default false, primary key(pack_id,user_id)
);
create table if not exists sandbox_orders (
  id uuid primary key, user_id uuid not null references users, base_cents int not null check (base_cents in (1000,3000,4900)),
  amount_cents int not null check (amount_cents > base_cents and amount_cents <= base_cents + 99),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment','pending_review','credited','rejected','expired')),
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  reviewer_id uuid references users
);
create unique index if not exists sandbox_orders_open_amount on sandbox_orders(amount_cents) where status in ('awaiting_payment','pending_review');
create index if not exists sandbox_orders_owner on sandbox_orders(user_id,created_at desc);
create table if not exists sandbox_events (
  id bigint generated always as identity primary key, order_id uuid not null references sandbox_orders,
  actor_id uuid not null references users, status text not null, created_at timestamptz not null default now()
);
create table if not exists sandbox_book (
  order_id uuid primary key references sandbox_orders, amount_cents int not null check (amount_cents > 0),
  created_at timestamptz not null default now()
);
create table if not exists ai_prices (
  version int primary key, input_weight int not null, output_weight int not null, divisor int not null
);
insert into ai_prices values (1,3,12,10000) on conflict do nothing;
create table if not exists ai_usage (
  attempt_id uuid primary key references attempts, user_id uuid not null references users,
  price_version int not null references ai_prices, input_tokens int not null, output_tokens int not null,
  cost_cc int not null, feedback text not null, created_at timestamptz not null default now()
);
-- Real-provider accounting: whether the call was covered by the free allowance, and which
-- upstream model produced it. Neither value is exposed on any page.
alter table ai_usage add column if not exists free boolean not null default false;
alter table ai_usage add column if not exists model text;
-- Per-question assistant chats: one row per ask, accounting only (conversations
-- are kept client-side and are not stored).
create table if not exists ai_asks (
  id bigint generated always as identity primary key,
  user_id uuid not null references users,
  attempt_id uuid not null references attempts,
  question_id uuid not null references questions,
  input_tokens int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  cost_cc int not null default 0 check (cost_cc >= 0),
  free boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ai_asks_user on ai_asks(user_id, created_at desc);
create table if not exists resource_courses (
  id text primary key,
  collection text not null,
  name text not null,
  repository text not null,
  repository_name text not null,
  contributor text not null,
  contributor_url text not null,
  sort_order int not null default 0
);
create table if not exists resource_files (
  id text primary key,
  course_id text not null references resource_courses on delete cascade,
  title text not null,
  category text not null,
  term text,
  instructor text,
  extension text not null,
  mime text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  storage_key text not null,
  source_path text not null,
  source_url text not null,
  sha256 text not null,
  sort_order int not null default 0
);
alter table resource_files drop constraint if exists resource_files_storage_key_key;
create index if not exists resource_files_course on resource_files(course_id, sort_order);
create index if not exists resource_files_storage on resource_files(storage_key);

-- One-time Agent handoff codes: narrow capability tokens created in the browser and
-- pasted into a local MCP client. They are not account tokens: the code can only open
-- one bound pack (or buy one pack inside a CC budget) and cannot read the account.
create table if not exists handoff_codes (
  id uuid primary key,
  code_hash text not null unique,
  user_id uuid not null references users,
  mode text not null check (mode in ('pack','catalog')),
  pack_id uuid references packs,
  license text not null default 'practice' check (license in ('practice','read','collection')),
  budget_cc int not null default 0 check (budget_cc >= 0),
  spent_cc int not null default 0 check (spent_cc >= 0),
  attempt_id uuid references attempts,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
-- A pack code must name its pack up front; a catalogue code gains one when it opens a pack.
alter table handoff_codes drop constraint if exists handoff_shape;
alter table handoff_codes add constraint handoff_shape check (mode = 'catalog' or pack_id is not null);
create index if not exists handoff_owner on handoff_codes(user_id, created_at desc);

-- Time-boxed site-wide promotions. Access checks read this table, so a campaign can be
-- started or stopped from the CLI without a deploy.
create table if not exists promotions (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('free_all')),
  title text not null,
  note text,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists promotions_active on promotions(kind, active, ends_at desc);

-- Typed drill questions: choice keeps the legacy shape; judge/fill/subjective carry
-- their public parts in qtype/fields while graded answers stay inside answer_data.
alter table questions add column if not exists qtype text not null default 'choice'
  check (qtype in ('choice', 'judge', 'fill', 'subjective'));
alter table questions add column if not exists body text not null default '';
alter table questions add column if not exists fields jsonb not null default '[]';
alter table questions add column if not exists ref text;
create unique index if not exists questions_pack_ref on questions(pack_id, ref) where ref is not null;

-- Pack-level study notes shown on the drill page, and the free-sample flag that
-- opens a pack for practice, collection and rubric without any licence.
alter table packs add column if not exists notes text;
alter table packs add column if not exists subtitle text;
alter table packs add column if not exists is_sample boolean not null default false;

-- Drill records live per user × pack (not per attempt), mirroring the standalone
-- quiz-room behaviour: progress, wrong-book and favourites survive re-entry.
create table if not exists practice_records (
  user_id uuid not null references users,
  pack_id uuid not null references packs,
  question_id uuid not null references questions,
  result jsonb,                          -- {choice?, fields?: bool[], correct}
  draft jsonb not null default '[]',     -- fill string[] / subjective string
  starred boolean not null default false,
  mastered boolean not null default false,
  ever_wrong boolean not null default false,
  tries int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, pack_id, question_id)
);

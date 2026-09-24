-- WhatsApp digest
-- (comments, songs, versions, comment_likes and reply_likes already have created_at default now())

create index if not exists comment_likes_created_at_idx on public.comment_likes (created_at);
create index if not exists reply_likes_created_at_idx   on public.reply_likes (created_at);

-- Who receives the digest.
-- RLS is on with NO policies: only the service key (used by the Worker) can
-- read phone numbers and CallMeBot keys; the website's publishable key can't.
create table if not exists public.digest_subscribers (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  phone            text not null,              -- international format, e.g. +31612345678
  callmebot_apikey text not null,              -- personal key from CallMeBot
  enabled          boolean not null default true,
  last_digest_at   timestamptz,                -- end of the window covered by the last digest
  last_error       text,
  created_at       timestamptz not null default now()
);
alter table public.digest_subscribers enable row level security;

-- Add members (one row per person):
--
-- insert into public.digest_subscribers (user_id, phone, callmebot_apikey)
-- select id, '+316XXXXXXXX', '1234567' from public.profiles where name = 'Charles';

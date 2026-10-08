-- Switch the digest from WhatsApp (CallMeBot) to email.

-- Where each person's digest is emailed to.
alter table public.digest_subscribers add column if not exists email text;

-- Phone / CallMeBot key are no longer needed (kept for now, but optional).
alter table public.digest_subscribers alter column phone drop not null;
alter table public.digest_subscribers alter column callmebot_apikey drop not null;

-- Start with the address each person logs in to MixReview with.
-- To use another address for someone:
--   update public.digest_subscribers set email = 'them@example.com'
--   where user_id = (select id from public.profiles where name = 'Nikil');
update public.digest_subscribers s
set email = u.email
from auth.users u
where u.id = s.user_id and s.email is null;

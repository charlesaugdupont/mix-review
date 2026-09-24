# WhatsApp digest

Every **day at 09:00 (Amsterdam time)** the Worker sends each
subscriber a WhatsApp message via [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/) with:

- **For everyone:** new songs, new versions, and new comments/replies per song
  (your own comments and replies aren't counted).
- **For you:** comments and replies that @tag you, who liked your comments/replies, and new
  replies on your comments or in threads you replied to or were tagged in (only replies posted
  after you joined the thread). Tags added by editing an older comment aren't picked up.

Comments are shown in full as WhatsApp quotes, grouped per thread. If a very busy day would make
the message too long for CallMeBot (it's sent inside a URL), the band list is shortened first,
then the oldest "for you" threads are left out with a "…and N more" line.

Each person's digest covers the time since *their* last one. If sending fails, their window
isn't advanced, so the next digest picks up the missed period. When there's nothing new,
they get a short "No new updates" message.

## Files

| File | What it does |
|---|---|
| `server/digest-core.js` | Works out the activity and formats the message (no network code) |
| `server/digest.js` | Reads Supabase with the service key, sends via CallMeBot, saves `last_digest_at` |
| `worker.js` | `scheduled()` cron handler + `/api/digest` preview/send endpoint |
| `wrangler.jsonc` | Cron trigger `0 7,8 * * *` (UTC). The handler only runs the one that is 09:00 in Amsterdam, so it keeps working across summer and winter time |
| `supabase/migrations/20260923_whatsapp_digest.sql` | Adds like timestamps and the `digest_subscribers` table |
| `.assetsignore` | Stops server files from being served as static assets |

## Setup

1. **Database:** run `supabase/migrations/20260923_whatsapp_digest.sql` in the Supabase SQL editor (done).
2. **CallMeBot opt-in (each member, once):** follow the setup on
   https://www.callmebot.com/blog/free-api-whatsapp-messages/ — add the bot number shown there
   to your contacts (it changes from time to time), send it `I allow callmebot to send me messages`,
   and note the API key it replies with.
3. **Subscribers:** for each member, run:
   ```sql
   insert into public.digest_subscribers (user_id, phone, callmebot_apikey)
   select id, '+316XXXXXXXX', 'THEIR_KEY' from public.profiles where name = 'Charles';
   ```
   To pause someone: `update public.digest_subscribers set enabled = false where ...`.
4. **Secrets:**
   ```sh
   npx wrangler secret put SUPABASE_SERVICE_KEY   # Supabase → Settings → API keys → secret (or legacy service_role) key
   npx wrangler secret put DIGEST_ADMIN_TOKEN     # any long random string, e.g. `openssl rand -hex 24`
   ```
5. Optionally set `APP_URL` in `wrangler.jsonc` to the site URL so the message ends with a link.
6. `npx wrangler deploy`.

## Testing

```sh
# Preview everyone's message for the last 3 days (sends nothing, changes nothing)
curl -H "Authorization: Bearer $DIGEST_ADMIN_TOKEN" "https://<your-site>/api/digest?hours=72"

# Send a real digest now to one person (also advances their window)
curl -X POST -H "Authorization: Bearer $DIGEST_ADMIN_TOKEN" "https://<your-site>/api/digest?user=<their-uuid>"
```

`GET` never sends. `POST` sends and saves `last_digest_at`. `?hours=N` sets the window,
and `?user=<uuid>` limits it to one person. Without a valid token the endpoint returns 404.
Send failures are saved in `digest_subscribers.last_error` and in the Worker logs.

## Limitation

Reply likes are stored by the reply's position (`reply_index`). If a reply is deleted, later
replies shift position, so an old like can end up pointing at a different reply. This problem
already existed in the app. The digest only reports likes made since the last digest, so this
rarely shows up.

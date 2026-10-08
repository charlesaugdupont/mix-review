# Email digest

Every **day at 09:00 (Amsterdam time)** the Worker emails each subscriber with new activity a digest, sent through
[Brevo](https://www.brevo.com/) (free plan: 300 emails/day). It used to go out on WhatsApp via
CallMeBot, which turned out to be unreliable (messages cut off at ~730 characters, accounts paused).

- **For you:** comments and replies that @tag you, who liked your comments/replies, and new
  replies on your comments or in threads you replied to or were tagged in (only replies posted
  after you joined the thread), grouped per thread with comments in full. Tags added by editing
  an older comment aren't picked up.
- **Band activity:** new songs, new versions, and new comments/replies per song
  (your own comments and replies aren't counted).

Each person's digest covers the time since *their* last one. If sending fails, their window
isn't advanced, so the next digest picks up the missed period. When there's nothing new for
someone, no email is sent that day.

## Files

| File | What it does |
|---|---|
| `server/digest-core.js` | Works out the activity and builds the email: subject, HTML and plain text (no network code) |
| `server/digest.js` | Reads Supabase with the service key, sends via Brevo, saves `last_digest_at` |
| `worker.js` | `scheduled()` cron handler + `/api/digest` preview/send endpoint |
| `wrangler.jsonc` | Cron trigger `0 7,8 * * *` (UTC). The handler only runs the one that is 09:00 in Amsterdam, so it keeps working across summer and winter time |
| `supabase/migrations/20260923_whatsapp_digest.sql` | Adds the `digest_subscribers` table |
| `supabase/migrations/20261008_email_digest.sql` | Adds the `email` column, filled with each person's login address |
| `.assetsignore` | Stops server files from being served as static assets |

## Setup

1. **Database:** run both migrations in the Supabase SQL editor.
2. **Brevo:** create a free account, then
   - *Senders, Domains & Dedicated IPs → Senders → Add a sender*: the address the digest comes
     from (e.g. your Gmail). Brevo emails it a confirmation link.
   - *SMTP & API → API keys → Generate a new API key*.
3. **Secrets:**
   ```sh
   npx wrangler secret put SUPABASE_SERVICE_KEY   # Supabase → Settings → API keys → secret key
   npx wrangler secret put DIGEST_ADMIN_TOKEN     # any long random string, e.g. `openssl rand -hex 24`
   npx wrangler secret put BREVO_API_KEY          # from step 2
   npx wrangler secret put DIGEST_FROM_EMAIL      # the sender verified in step 2
   ```
4. `npx wrangler deploy`.

Subscribers: one row per person in `digest_subscribers` (`user_id`, `email`). To use a different
address: `update public.digest_subscribers set email = '…' where user_id = …`. To pause someone:
`set enabled = false`.

Sending from a Gmail address through Brevo can land in spam at first; ask everyone to mark the
first digest as "not spam" (or add the sender to their contacts).

## Testing

```sh
# Preview everyone's digest for the last 3 days: subject + plain text (sends nothing, changes nothing)
curl -H "Authorization: Bearer $DIGEST_ADMIN_TOKEN" "https://<your-site>/api/digest?hours=72"

# See one person's email as it will look
curl -H "Authorization: Bearer $DIGEST_ADMIN_TOKEN" "https://<your-site>/api/digest?user=<their-uuid>&hours=72&view=html" > preview.html && open preview.html

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

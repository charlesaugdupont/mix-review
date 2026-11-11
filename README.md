# MixReview

**A private web app where a band reviews its own mixes together, with comments pinned to the exact second of the song they're about.**

Live at <https://mix-review.charlesdupont1997.workers.dev/> (members only).

---

## Why it exists

When a band works on a record, mixes and demos go back and forth constantly. Usually that feedback
ends up in a group chat: *"the snare around 2:10 in the second mix is too loud"*, *"which version are
we talking about?"*, *"did anyone fix the ending?"*. The comments drift away from the audio and get
buried, and nobody can tell which notes are dealt with.

MixReview keeps all of that next to the audio:

- Every song keeps **all its versions** (demo, V1, rough mix, final…) in one place.
- Every comment is **pinned to a timestamp** on a specific version, so it sits on the waveform and
  one click takes you to that moment.
- Comments can be **replied to, liked, @tagged, and marked resolved**, so the open notes stand
  out from the finished ones.
- A **daily email digest** tells each member what happened since their last one, so nobody has to
  keep checking the site.

It's built for a small, trusted group (one band), not as a public SaaS. That shapes most of the
choices below: no build step, everything on free tiers, and few moving parts.

---

## What it does

### Listening
- Waveform player with a playhead, hover time and click-to-seek.
- **Version pills**: switch between versions of a song. The playhead stays where it was, so you
  can A/B the same passage across mixes.
- **Loop a section**: drag across the waveform to loop a region (handy for checking a fill or
  transition over and over). `Esc` clears it.
- `Space` to play/pause, a volume control, and **download** of the current version.
- When a song ends, the next one in the list starts (album-style listening).
- The newest version of a song opens by default.

### Feedback
- Post a comment at the current playhead time (`@3:27`). Comments show as dots on the waveform.
- Threaded **replies**, **likes** on comments and replies (with who liked it), edit and delete.
- **@mentions**: typing `@` suggests band members; tags are highlighted and feed the digest.
- **Resolve** a comment once it's handled; resolved ones collapse into their own section.
- **Unread tracking** per person: badges on songs and folders, plus "Mark all as read".

### Organising
- Songs live in **folders** (e.g. an album, "Next EP") that you can create, rename, collapse and delete.
- **Drag and drop** songs to reorder them or move them between folders.
- Upload a **new song** or a **new version** of an existing song (MP3 recommended).

### Daily digest
Every day at 09:00 Amsterdam time each subscriber gets an email (sent only if something happened) with:
- **For you:** comments that tag you, likes on your comments and replies, and new replies in threads
  you started, replied to, or were tagged in.
- **Band activity:** new songs, new versions, and comment and reply counts per song.

Full details, setup and testing are in [`DIGEST.md`](DIGEST.md).

### Access
Login is email and password through Supabase Auth. There's no sign-up form: members are added by
hand in Supabase, and each needs a row in `profiles` (name and avatar colour).

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Plain HTML, CSS and vanilla JavaScript: no framework, no bundler, no `package.json` |
| Audio and waveform | HTML `<audio>` element, Web Audio API (`decodeAudioData`) for the waveform, `<canvas>` to draw it |
| Backend data | [Supabase](https://supabase.com/): Postgres, Auth, Storage (bucket `audio`), queried from the browser with `supabase-js` v2 (CDN) |
| Hosting and edge | [Cloudflare Workers](https://developers.cloudflare.com/workers/) with static assets, configured with Wrangler |
| Scheduled jobs | Cloudflare Cron Triggers |
| Email | [Brevo](https://www.brevo.com/) transactional email API (free plan) |
| Font | Inter (Google Fonts) |

---

## How it works

```
                    ┌──────────────────────────── Cloudflare Worker (worker.js) ────────────────────────────┐
 Browser ──────────▶│  /                → static assets (index.html, css/, js/)                              │
  (js/main.js)      │  /audio-proxy/*   → fetch from Supabase Storage, cache at the edge, add CORS           │──▶ Supabase Storage
     │              │  /api/digest      → admin-only preview or send of the digest (bearer token)            │
     │              │  scheduled()      → daily cron → server/digest.js → Brevo                              │──▶ Brevo (email)
     │              └────────────────────────────────────────────────────────────────────────────────────────┘
     │                                                         │ service key (server side only)
     └────────── supabase-js (publishable key, RLS) ──────────▶│ Supabase Postgres + Auth
```

### Frontend (`index.html`, `js/main.js`, `css/style.css`)
The whole app is one page. `main.js` signs in with Supabase Auth, then reads and writes the tables
directly with the publishable key (Row Level Security in Supabase decides what's allowed). Rendering
is done by building HTML strings by hand, and user text is escaped before it's inserted.

**Waveforms** are computed in the browser: the file is downloaded once, decoded with the Web Audio API,
mixed down to mono, and reduced to 250 RMS bars, normalised to the loudest one. The bars are cached in
`localStorage` per version, so a mix only needs analysing once per browser. Collapsed folders are
remembered in `localStorage` too.

**Uploads** go straight from the browser to the Supabase Storage bucket `audio`. A row is then
added to `songs` and/or `versions` pointing at the file's public URL.

### Audio proxy and edge caching (`worker.js`)
The audio isn't played straight from Supabase. It's played through `/audio-proxy/<filename>` on the
Worker, which:
1. looks the file up in Cloudflare's edge cache,
2. on a miss, fetches it once from Supabase Storage and stores it with a one-year immutable cache header,
3. returns it with CORS headers (needed so the browser can decode it for the waveform).

**Why:** a band replays and scrubs the same few mixes many times. Without this, every play would
count against Supabase's storage egress. With it, each file is fetched from Supabase about once per
edge location, and seeking still works because the Cache API serves `Range` requests from the cached
copy. The Worker also drops Supabase's `Set-Cookie` header, which isn't valid on this domain.

### Digest (`server/`, cron in `wrangler.jsonc`)
- `server/digest-core.js` holds the logic only (no network): given the rows and a time window, it
  works out each person's activity and builds the email subject, HTML and plain text.
- `server/digest.js` handles I/O: reads Supabase over REST with the **service key** (server side
  only), sends through Brevo, and saves `last_digest_at` / `last_error` per subscriber.
- The cron fires at **07:00 and 08:00 UTC** and the handler only continues on the run that's 09:00
  in Amsterdam, so the time stays right across summer and winter time.
- Each person's window starts at *their* last digest. If a send fails, the window isn't moved on,
  so the next digest covers the missed period.

The digest was first sent over WhatsApp (CallMeBot) and moved to email because that channel cut
messages off and paused accounts. The old `phone` and `callmebot_apikey` columns are still in the
table but are now optional.

### Data model (Supabase)
The core tables were created in the Supabase dashboard; only the digest changes are in
`supabase/migrations/`.

| Table | Holds |
|---|---|
| `profiles` | One per member: `id` (= auth user id), `name`, `color` |
| `folders` | `id`, `name`, `sort_order` |
| `songs` | `id`, `title`, `folder_id`, `sort_order`, `created_at` |
| `versions` | `id`, `song_id`, `label`, `file_url`, `created_at` |
| `comments` | `song_id`, `version_id`, `author`, `timestamp_sec`, `content`, `resolved`, `replies` (JSON array stored as text), `created_at` |
| `comment_likes` | `comment_id`, `user_id`, `created_at` |
| `reply_likes` | `comment_id`, `reply_index`, `user_id`, `created_at` |
| `comment_reads` | `user_id`, `comment_id` (unique together) |
| `digest_subscribers` | `user_id`, `email`, `enabled`, `last_digest_at`, `last_error` (RLS on with no policies, so only the service key can read it) |

Replies are stored inside their comment rather than in a table of their own, which keeps a thread
to one row. The catch: reply likes point at a reply by **position**, so deleting a reply can shift
older likes onto a different reply (see "Limitation" in `DIGEST.md`).

---

## Project layout

```
.
├── index.html                  App shell: layout, player, modals
├── css/style.css               All styles (dark theme, mobile layout below 900px)
├── js/main.js                  All client logic: auth, songs, folders, player, waveform, loops, comments, mentions, uploads
├── worker.js                   Cloudflare Worker: static assets, audio proxy, /api/digest, cron handler
├── wrangler.jsonc              Worker config: assets, cron, public vars, list of secrets
├── server/
│   ├── digest-core.js          Digest logic and email formatting (no network)
│   └── digest.js               Digest I/O: Supabase reads, Brevo send, state
├── supabase/migrations/        SQL for the digest tables
├── functions/audio-proxy/      Older Cloudflare Pages Function version of the audio proxy (now handled in worker.js)
├── DIGEST.md                   Digest docs: setup, testing, limits
└── .assetsignore               Keeps server files from being served as static assets
```

---

## Running and deploying

There are no dependencies to install; Wrangler runs through `npx`.

```sh
# Local dev (serves the app and runs the Worker locally)
npx wrangler dev

# Deploy
npx wrangler deploy
```

The Supabase URL and **publishable** key are set in `js/main.js` (they're meant to be public, and
access is controlled by RLS). The audio proxy URL is set in `cdnUrl()` in `js/main.js` and in
`worker.js`.

The Worker's public settings (`SUPABASE_URL`, `APP_URL`) are in `wrangler.jsonc`. Secrets are set
with `npx wrangler secret put <NAME>`:

| Secret | Used for |
|---|---|
| `SUPABASE_SERVICE_KEY` | Server-side reads for the digest (bypasses RLS, never sent to the browser) |
| `DIGEST_ADMIN_TOKEN` | Protects `/api/digest` |
| `BREVO_API_KEY` | Sending the digest email |
| `DIGEST_FROM_EMAIL` | Sender address, verified in Brevo |

To set up the digest from scratch, follow [`DIGEST.md`](DIGEST.md).

### Adding a band member
1. Supabase → Authentication → add the user (email and password).
2. Add a row in `profiles` with the same `id`, their `name` and an avatar `color`.
3. For the digest, add them to `digest_subscribers` (see `DIGEST.md`).

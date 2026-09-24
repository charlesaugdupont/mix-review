// Digest I/O: reads from Supabase (service key), sends via CallMeBot, records state.
import { buildDigest, formatDigest } from './digest-core.js';

const HOUR = 3600 * 1000;
const FIRST_DIGEST_LOOKBACK = 24 * HOUR; // window for a subscriber's very first digest
const RESEND_GUARD = 2 * HOUR;           // cron never sends to the same person twice within this
const SEND_GAP_MS = 2000;                // pause between CallMeBot calls

// ── Supabase REST helpers ──────────────────────────────────────────────────
function sbHeaders(env) {
  const key = String(env.SUPABASE_SERVICE_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!key) throw new Error('SUPABASE_SERVICE_KEY secret is not set');
  if (key.startsWith('sb_publishable_')) throw new Error('SUPABASE_SERVICE_KEY is the publishable key; use the secret key (sb_secret_…) instead');
  if (key.includes('•') || key.includes('*')) throw new Error('SUPABASE_SERVICE_KEY looks like the masked key; use the copy button in Supabase instead');
  const h = { apikey: key };
  // Legacy service_role keys are JWTs and go in Authorization too; new sb_secret_ keys only in apikey.
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key;
  return h;
}

async function sbSelect(env, path) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const res = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
      headers: { ...sbHeaders(env), 'Range-Unit': 'items', Range: from + '-' + (from + pageSize - 1) },
    });
    if (!res.ok) throw new Error('Supabase read ' + path.split('?')[0] + ' failed: ' + res.status + ' ' + (await res.text()));
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function sbUpdate(env, table, filter, body) {
  const res = await fetch(env.SUPABASE_URL + '/rest/v1/' + table + '?' + filter, {
    method: 'PATCH',
    headers: { ...sbHeaders(env), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Supabase update ' + table + ' failed: ' + res.status + ' ' + (await res.text()));
}

// ── CallMeBot ──────────────────────────────────────────────────────────────
export async function sendWhatsApp(phone, apikey, text) {
  const url = 'https://api.callmebot.com/whatsapp.php'
    + '?phone=' + encodeURIComponent(phone)
    + '&text=' + encodeURIComponent(text)
    + '&apikey=' + encodeURIComponent(apikey);
  const res = await fetch(url);
  const body = (await res.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  // CallMeBot echoes the phone number and message text back, then says "Message queued" on
  // success or explains the problem (e.g. "Message not sent", invalid API key) otherwise.
  // The error keeps the end of the reply, where the reason is.
  if (!res.ok || /not sent/i.test(body) || !/queued|sent/i.test(body)) {
    throw new Error('CallMeBot ' + res.status + ': …' + body.slice(-300));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main entry point ───────────────────────────────────────────────────────
/**
 * @param {object} env
 * @param {object} opts
 * @param {boolean} [opts.dryRun]    build messages but don't send or record anything
 * @param {boolean} [opts.fromCron]  apply the resend guard
 * @param {number}  [opts.since]     override window start (ms) for everyone
 * @param {string}  [opts.userId]    only this subscriber
 * @param {Date}    [opts.now]
 */
export async function runDigest(env, opts = {}) {
  const now = (opts.now || new Date()).getTime();
  const nowIso = new Date(now).toISOString();

  let subs = await sbSelect(env, 'digest_subscribers?select=user_id,phone,callmebot_apikey,last_digest_at&enabled=eq.true&order=user_id');
  if (opts.userId) subs = subs.filter((s) => s.user_id === opts.userId);
  if (!subs.length) return { now: nowIso, results: [] };

  const sinceOf = (s) => opts.since != null ? opts.since
    : s.last_digest_at ? Date.parse(s.last_digest_at) : now - FIRST_DIGEST_LOOKBACK;
  const minSince = new Date(Math.min(...subs.map(sinceOf))).toISOString();
  const after = 'created_at=gt.' + encodeURIComponent(minSince);

  const [profiles, songs, versions, comments, commentLikes, replyLikes] = await Promise.all([
    sbSelect(env, 'profiles?select=id,name&order=id'),
    sbSelect(env, 'songs?select=id,title,created_at&order=id'),
    sbSelect(env, 'versions?select=id,song_id,label,created_at&order=id'),
    // All comments: replies live in a JSON column, so an old comment can hold a new reply.
    sbSelect(env, 'comments?select=id,song_id,version_id,author,content,timestamp_sec,replies,created_at&order=id'),
    sbSelect(env, 'comment_likes?select=comment_id,user_id,created_at&' + after + '&order=created_at,comment_id,user_id'),
    sbSelect(env, 'reply_likes?select=comment_id,reply_index,user_id,created_at&' + after + '&order=created_at,comment_id,reply_index,user_id'),
  ]);
  const profilesById = new Map(profiles.map((u) => [u.id, u]));

  const results = [];
  let sentAny = false;
  for (const sub of subs) {
    const user = profilesById.get(sub.user_id);
    const r = { user: user ? user.name : sub.user_id };
    results.push(r);
    try {
      if (!user) throw new Error('no profile for this user_id');
      if (!opts.dryRun && opts.fromCron && sub.last_digest_at && now - Date.parse(sub.last_digest_at) < RESEND_GUARD) {
        r.status = 'skipped: sent recently';
        continue;
      }
      const since = sinceOf(sub);
      const digest = buildDigest({ user, since, until: now, songs, versions, comments, commentLikes, replyLikes, profiles });
      const text = formatDigest(digest, { appUrl: env.APP_URL });
      r.since = new Date(since).toISOString();
      r.text = text;

      if (opts.dryRun) { r.status = text ? 'preview' : 'nothing new'; continue; }
      if (text) {
        if (sentAny) await sleep(SEND_GAP_MS);
        await sendWhatsApp(sub.phone, sub.callmebot_apikey, text);
        sentAny = true;
        r.status = 'sent';
      } else {
        r.status = 'nothing new';
      }
      await sbUpdate(env, 'digest_subscribers', 'user_id=eq.' + sub.user_id, { last_digest_at: nowIso, last_error: null });
    } catch (e) {
      r.status = 'error';
      r.error = String(e && e.message || e);
      // Window isn't advanced on failure, so the next digest still covers this period.
      if (!opts.dryRun) {
        await sbUpdate(env, 'digest_subscribers', 'user_id=eq.' + sub.user_id, { last_error: r.error.slice(0, 500) }).catch(() => {});
      }
    }
  }
  return { now: nowIso, results };
}

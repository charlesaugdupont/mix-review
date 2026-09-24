// Pure digest logic: no network, no env. Given the raw rows and a time window,
// work out what happened and turn it into a WhatsApp message for one user.

const TZ = 'Europe/Amsterdam';
// CallMeBot takes the message in the URL; web servers commonly reject URLs over ~8 KB.
// Keep the URL-encoded text under this, trimming the digest only when it would go over.
export const MAX_ENCODED = 6000;

export function parseReplies(raw) {
  try {
    const r = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    return Array.isArray(r) ? r : [];
  } catch (e) {
    return [];
  }
}

const norm = (s) => String(s || '').trim().toLowerCase();

function ts(v) {
  if (!v) return NaN;
  return Date.parse(v);
}

/**
 * @param {object} p
 * @param {{id:string,name:string}} p.user
 * @param {number} p.since   window start (ms, exclusive)
 * @param {number} p.until   window end (ms, inclusive)
 * @param {Array} p.songs         {id,title,created_at}
 * @param {Array} p.versions      {id,song_id,label,created_at}
 * @param {Array} p.comments      {id,song_id,version_id,author,content,timestamp_sec,replies,created_at}
 * @param {Array} p.commentLikes  {comment_id,user_id,created_at}
 * @param {Array} p.replyLikes    {comment_id,reply_index,user_id,created_at}
 * @param {Array} p.profiles      {id,name}
 */
export function buildDigest(p) {
  const { user, since, until } = p;
  const inWindow = (v) => { const t = ts(v); return !isNaN(t) && t > since && t <= until; };
  const me = norm(user.name);
  const isMe = (name) => norm(name) === me;

  const songsById = new Map(p.songs.map((s) => [s.id, s]));
  const versionsById = new Map(p.versions.map((v) => [v.id, v]));
  const profilesById = new Map(p.profiles.map((u) => [u.id, u]));
  const commentsById = new Map(p.comments.map((c) => [c.id, c]));
  const songIdOf = (c) => c.song_id || (versionsById.get(c.version_id) || {}).song_id;
  const songTitle = (sid) => (songsById.get(sid) || {}).title || 'a deleted song';
  const nameOf = (uid) => (profilesById.get(uid) || {}).name || 'Someone';

  // ── Global activity ──────────────────────────────────────────────────────
  const newSongs = p.songs.filter((s) => inWindow(s.created_at));
  const newSongIds = new Set(newSongs.map((s) => s.id));
  const newVersions = p.versions
    .filter((v) => inWindow(v.created_at) && !newSongIds.has(v.song_id))
    .map((v) => ({ song: songTitle(v.song_id), label: v.label }));

  const perSong = new Map(); // songId → { comments, replies }
  const bump = (sid, key) => {
    if (!perSong.has(sid)) perSong.set(sid, { comments: 0, replies: 0 });
    perSong.get(sid)[key]++;
  };
  for (const c of p.comments) {
    const sid = songIdOf(c);
    if (inWindow(c.created_at) && !isMe(c.author)) bump(sid, 'comments');
    for (const r of parseReplies(c.replies)) {
      if (inWindow(r.created_at) && !isMe(r.author)) bump(sid, 'replies');
    }
  }
  const commentActivity = [...perSong.entries()]
    .map(([sid, n]) => ({ song: songTitle(sid), ...n, total: n.comments + n.replies }))
    .sort((a, b) => b.total - a.total || a.song.localeCompare(b.song));

  // ── Personal: everything that concerns me, grouped per comment thread ───
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagRe = new RegExp('(^|[^\\w@])@' + escRe(String(user.name || '').trim()) + '(?!\\w)', 'i');
  const tagsMe = (text) => !!me && tagRe.test(String(text || ''));

  const groups = new Map(); // comment id → { song, at, author, text, mine, events: [] }
  const groupFor = (c) => {
    if (!groups.has(c.id)) {
      groups.set(c.id, { song: songTitle(songIdOf(c)), at: c.timestamp_sec, author: c.author, text: c.content, mine: isMe(c.author), events: [] });
    }
    return groups.get(c.id);
  };

  for (const c of p.comments) {
    const replies = parseReplies(c.replies);
    const mine = isMe(c.author);
    // Tagged in a new comment
    if (inWindow(c.created_at) && !mine && tagsMe(c.content)) {
      groupFor(c).events.push({ type: 'tag', who: c.author, when: ts(c.created_at) });
    }
    // I'm in a thread if I started it, replied in it, or was @tagged in it. Only replies
    // after I joined count (no timestamp = old).
    const joins = replies.filter((r) => isMe(r.author) || tagsMe(r.text)).map((r) => ts(r.created_at) || -Infinity);
    if (tagsMe(c.content)) joins.push(ts(c.created_at) || -Infinity);
    const involved = mine || joins.length > 0;
    const joinedAt = mine ? -Infinity : Math.min(...joins);
    for (const r of replies) {
      if (!inWindow(r.created_at) || isMe(r.author)) continue;
      const when = ts(r.created_at);
      if (tagsMe(r.text)) groupFor(c).events.push({ type: 'tag-reply', who: r.author, text: r.text, when });
      else if (involved && when > joinedAt) groupFor(c).events.push({ type: 'reply', who: r.author, text: r.text, when });
    }
  }

  // Likes on my comments and replies (several likers of the same item → one line)
  const addLike = (c, target, idx, text, l) => {
    const g = groupFor(c);
    let ev = g.events.find((e) => e.type === 'like' && e.target === target && e.idx === idx);
    if (!ev) { ev = { type: 'like', target, idx, text, likers: [], when: -Infinity }; g.events.push(ev); }
    const name = nameOf(l.user_id);
    if (!ev.likers.includes(name)) ev.likers.push(name);
    ev.when = Math.max(ev.when, ts(l.created_at));
  };
  for (const l of p.commentLikes) {
    if (!inWindow(l.created_at) || l.user_id === user.id) continue;
    const c = commentsById.get(l.comment_id);
    if (c && isMe(c.author)) addLike(c, 'comment', null, null, l);
  }
  for (const l of p.replyLikes) {
    if (!inWindow(l.created_at) || l.user_id === user.id) continue;
    const c = commentsById.get(l.comment_id);
    const r = c && parseReplies(c.replies)[l.reply_index];
    if (r && isMe(r.author)) addLike(c, 'reply', l.reply_index, r.text, l);
  }

  // Within a thread: tags first, then likes, then replies in the order they were posted.
  const rank = { tag: 0, like: 1, 'tag-reply': 2, reply: 2 };
  const personal = [...groups.values()]
    .filter((g) => g.events.length)
    .map((g) => ({
      ...g,
      events: g.events.sort((a, b) => rank[a.type] - rank[b.type] || a.when - b.when),
      latest: Math.max(...g.events.map((e) => e.when)),
    }))
    .sort((a, b) => b.latest - a.latest);

  return { user, since, until, newSongs: newSongs.map((s) => s.title), newVersions, commentActivity, personal };
}

export function isEmpty(d) {
  return !d.newSongs.length && !d.newVersions.length && !d.commentActivity.length && !d.personal.length;
}

// ── Formatting ─────────────────────────────────────────────────────────────
export function ft(s) {
  s = Number(s);
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

export function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
}

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const DIVIDER = '━━━━━━━━━━━━';

// WhatsApp quote: the whole comment as one paragraph (line breaks joined with spaces).
// maxLen only kicks in when a message would otherwise be too long.
export function quote(text, maxLen = Infinity) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length > maxLen) t = t.slice(0, maxLen - 1).trimEnd() + '…';
  return '> ' + t;
}

const dateParts = (ms, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts }).format(new Date(ms));
const dayKey = (ms) => dateParts(ms, { year: 'numeric', month: '2-digit', day: '2-digit' });
const hhmm = (ms) => dateParts(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// "since yesterday 09:00", "since 07:39 today", or "since Wed 23 Sept, 10:41"
function sinceText(since, until) {
  if (dayKey(since) === dayKey(until)) return 'since ' + hhmm(since) + ' today';
  if (dayKey(since) === dayKey(until - 86400000)) return 'since yesterday ' + hhmm(since);
  return 'since ' + dateParts(since, { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + hhmm(since);
}

function renderGroup(g, quoteMax) {
  const whose = g.mine ? 'your comment' : g.author + "'s comment";
  const out = ['*' + g.song + ' @' + ft(g.at) + '* · ' + whose, quote(g.text, quoteMax)];
  for (const e of g.events) {
    if (e.type === 'tag') out.push('📣 *' + e.who + '* tagged you');
    else if (e.type === 'like' && e.target === 'comment') out.push('❤️ *' + joinNames(e.likers) + '* liked it');
    else if (e.type === 'like') out.push('❤️ *' + joinNames(e.likers) + '* liked your reply:', quote(e.text, quoteMax));
    else if (e.type === 'tag-reply') out.push('📣 *' + e.who + '* tagged you in a reply:', quote(e.text, quoteMax));
    else out.push('💬 *' + e.who + '* replied:', quote(e.text, quoteMax));
  }
  return out.join('\n');
}

function render(d, appUrl, { bandMax = Infinity, groupsMax = Infinity, quoteMax = Infinity } = {}) {
  const out = ['🎧 *MixReview* · ' + dateParts(d.until, { weekday: 'short', day: 'numeric', month: 'short' }),
    '_Everything ' + sinceText(d.since, d.until) + '_'];

  if (d.personal.length) {
    const shown = d.personal.slice(0, groupsMax);
    out.push('', DIVIDER, '👤 *FOR YOU*');
    for (const g of shown) out.push('', renderGroup(g, quoteMax));
    const hidden = d.personal.length - shown.length;
    if (hidden > 0) out.push('', '_…and ' + hidden + ' more for you in MixReview_');
  }

  const band = [
    ...d.newSongs.map((t) => '🆕 New song: *' + t + '*'),
    ...d.newVersions.map((v) => '🆕 New version: *' + v.song + '* · ' + v.label),
    ...d.commentActivity.map((a) => {
      const parts = [];
      if (a.comments) parts.push(plural(a.comments, 'comment', 'comments'));
      if (a.replies) parts.push(plural(a.replies, 'reply', 'replies'));
      return '• *' + a.song + '*: ' + parts.join(', ');
    }),
  ];
  if (band.length) {
    out.push('', DIVIDER, '🎚️ *BAND ACTIVITY*');
    out.push(...band.slice(0, bandMax));
    if (band.length > bandMax) out.push('_…and ' + (band.length - bandMax) + ' more_');
  }

  if (appUrl) out.push('', 'Open MixReview → ' + appUrl);
  return out.join('\n');
}

function renderQuiet(d, appUrl) {
  const out = ['🎧 *MixReview* · ' + dateParts(d.until, { weekday: 'short', day: 'numeric', month: 'short' }),
    '_Everything ' + sinceText(d.since, d.until) + '_',
    '',
    '😴 No new updates: no new songs, versions, comments or likes from the band.'];
  if (appUrl) out.push('', 'Open MixReview → ' + appUrl);
  return out.join('\n');
}

/** Returns the WhatsApp text (a short "no new updates" message when nothing happened). */
export function formatDigest(d, { appUrl, maxEncoded = MAX_ENCODED } = {}) {
  if (isEmpty(d)) return renderQuiet(d, appUrl);
  // Full version first. Only if it's too long: shorten the band list, then leave out the
  // oldest "for you" threads, and as a last resort shorten very long comments.
  const attempts = [{}, { bandMax: 5 }];
  for (let n = d.personal.length - 1; n >= 1; n--) attempts.push({ bandMax: 5, groupsMax: n });
  attempts.push({ bandMax: 5, groupsMax: 1, quoteMax: 600 }, { bandMax: 3, groupsMax: 1, quoteMax: 200 });
  let text = '';
  for (const a of attempts) {
    text = render(d, appUrl, a);
    if (encodeURIComponent(text).length <= maxEncoded) break;
  }
  return text;
}

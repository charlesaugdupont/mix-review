// Pure digest logic: no network, no env. Given the raw rows and a time window,
// work out what happened and turn it into an email (subject, HTML and plain text) for one user.

const TZ = 'Europe/Amsterdam';
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
const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();   // comments as one paragraph

const formatters = new Map();
function dateParts(ms, opts) {
  const key = JSON.stringify(opts);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts }));
  return formatters.get(key).format(new Date(ms));
}
const dayKey = (ms) => dateParts(ms, { year: 'numeric', month: '2-digit', day: '2-digit' });
const hhmm = (ms) => dateParts(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayLabel = (ms) => dateParts(ms, { weekday: 'short', day: 'numeric', month: 'short' });

// "since yesterday 09:00", "since 07:39 today", or "since Wed 23 Sept, 10:41"
function sinceText(since, until) {
  if (dayKey(since) === dayKey(until)) return 'since ' + hhmm(since) + ' today';
  if (dayKey(since) === dayKey(until - 86400000)) return 'since yesterday ' + hhmm(since);
  return 'since ' + dayLabel(since) + ', ' + hhmm(since);
}

// One thread as a list of { line, quote? }: the heading's details are added by the caller.
function threadEvents(g) {
  return g.events.map((e) => {
    if (e.type === 'tag') return { who: e.who, action: 'tagged you', icon: '📣' };
    if (e.type === 'like' && e.target === 'comment') return { who: joinNames(e.likers), action: 'liked it', icon: '❤️' };
    if (e.type === 'like') return { who: joinNames(e.likers), action: 'liked your reply in this thread:', icon: '❤️', quote: e.text };
    if (e.type === 'tag-reply') return { who: e.who, action: 'tagged you in a reply in this thread:', icon: '📣', quote: e.text };
    return { who: e.who, action: 'replied in this thread:', icon: '💬', quote: e.text };
  });
}

function bandLines(d) {
  return [
    ...d.newSongs.map((t) => ({ icon: '🆕', label: 'New song', song: t })),
    ...d.newVersions.map((v) => ({ icon: '🆕', label: 'New version', song: v.song, extra: v.label })),
    ...d.commentActivity.map((a) => {
      const parts = [];
      if (a.comments) parts.push(plural(a.comments, 'comment', 'comments'));
      if (a.replies) parts.push(plural(a.replies, 'reply', 'replies'));
      return { icon: '•', song: a.song, extra: parts.join(', ') };
    }),
  ];
}

const whoseThread = (g) => (g.mine ? 'thread you started' : g.author + "'s thread");

// ── Plain-text version (shown by mail apps that don't display HTML) ──────────
function renderText(d, appUrl) {
  const out = ['MixReview · ' + dayLabel(d.until), 'Everything ' + sinceText(d.since, d.until), ''];
  if (isEmpty(d)) out.push('No new updates: no new songs, versions, comments or likes from the band.');
  if (d.personal.length) {
    out.push('FOR YOU', '');
    for (const g of d.personal) {
      out.push(g.song + ' @' + ft(g.at) + ' · ' + whoseThread(g), '  "' + oneLine(g.text) + '"');
      for (const e of threadEvents(g)) {
        out.push(e.icon + ' ' + e.who + ' ' + e.action);
        if (e.quote) out.push('  "' + oneLine(e.quote) + '"');
      }
      out.push('');
    }
  }
  const band = bandLines(d);
  if (band.length) {
    out.push('BAND ACTIVITY');
    for (const b of band) out.push(b.icon + ' ' + (b.label ? b.label + ': ' : '') + b.song + (b.extra ? (b.label ? ' · ' : ': ') + b.extra : ''));
    out.push('');
  }
  if (appUrl) out.push('Open MixReview: ' + appUrl);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ── HTML version ─────────────────────────────────────────────────────────────
const ACCENT = '#ff4d6d';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const htmlQuote = (t) => '<div style="border-left:3px solid #d5d9e0;padding:2px 0 2px 12px;margin:6px 0 12px;color:#30343c;">' + esc(oneLine(t)) + '</div>';
const sectionTitle = (t) => '<div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#7a808c;margin:4px 0 12px;">' + t + '</div>';

function renderHtml(d, appUrl) {
  const body = [];
  if (isEmpty(d)) {
    body.push('<p style="margin:0;">😴 No new updates: no new songs, versions, comments or likes from the band.</p>');
  }
  if (d.personal.length) {
    body.push(sectionTitle('👤 For you'));
    for (const g of d.personal) {
      const events = threadEvents(g).map((e) =>
        '<div style="margin:2px 0;">' + e.icon + ' <b>' + esc(e.who) + '</b> ' + esc(e.action) + '</div>' + (e.quote ? htmlQuote(e.quote) : '')).join('');
      body.push('<div style="border:1px solid #e6e8ee;border-radius:10px;padding:14px 16px;margin:0 0 14px;">'
        + '<div style="font-weight:700;font-size:15px;">' + esc(g.song) + ' <span style="color:' + ACCENT + ';">@' + ft(g.at) + '</span></div>'
        + '<div style="color:#7a808c;font-size:13px;">' + esc(whoseThread(g)) + '</div>'
        + htmlQuote(g.text) + events + '</div>');
    }
  }
  const band = bandLines(d);
  if (band.length) {
    body.push('<div style="margin-top:' + (d.personal.length ? '22' : '0') + 'px;">' + sectionTitle('🎚️ Band activity')
      + band.map((b) => '<div style="margin:4px 0;">' + b.icon + ' ' + (b.label ? esc(b.label) + ': ' : '') + '<b>' + esc(b.song) + '</b>'
        + (b.extra ? (b.label ? ' · ' : ': ') + esc(b.extra) : '') + '</div>').join('') + '</div>');
  }
  const button = appUrl
    ? '<div style="margin:22px 0 0;"><a href="' + esc(appUrl) + '" style="display:inline-block;background:' + ACCENT + ';color:#ffffff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px;">Open MixReview</a></div>'
    : '';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background:#f3f4f7;">'
    + '<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1b1e25;">'
    + '<div style="font-size:22px;font-weight:800;">🎧 Mix<span style="color:' + ACCENT + ';">Review</span></div>'
    + '<div style="color:#7a808c;font-size:14px;margin:2px 0 18px;">' + esc(dayLabel(d.until)) + ' · everything ' + esc(sinceText(d.since, d.until)) + '</div>'
    + '<div style="background:#ffffff;border-radius:12px;padding:20px;">' + body.join('') + '</div>'
    + button
    + '<div style="color:#9aa0ab;font-size:12px;margin-top:22px;">Your MixReview digest, sent at 09:00 on days with new activity.</div>'
    + '</div></body></html>';
}

/** The digest as an email: { subject, html, text }. Quiet days get a short "no new updates" email. */
export function formatEmail(d, { appUrl } = {}) {
  const date = dayLabel(d.until);
  const forYou = d.personal.reduce((n, g) => n + g.events.length, 0);
  const subject = isEmpty(d) ? 'MixReview: no new updates · ' + date
    : forYou ? 'MixReview: ' + plural(forYou, 'update', 'updates') + ' for you · ' + date
    : 'MixReview: new band activity · ' + date;
  return { subject, html: renderHtml(d, appUrl), text: renderText(d, appUrl) };
}

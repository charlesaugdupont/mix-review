// Pure digest logic: no network, no env. Given the raw rows and a time window,
// work out what happened and turn it into a WhatsApp message for one user.

const TZ = 'Europe/Amsterdam';
const MAX_SONGS = 8;      // songs listed under "New comments"
const MAX_PERSONAL = 6;   // items per personal section
const MAX_LIST = 6;       // new songs / new versions listed

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

  // ── Personal: likes on my comments / replies ─────────────────────────────
  const likeGroups = new Map(); // key → { kind, song, at, text, likers:Set }
  const addLike = (key, base, likerId) => {
    if (!likeGroups.has(key)) likeGroups.set(key, { ...base, likers: new Set() });
    likeGroups.get(key).likers.add(nameOf(likerId));
  };
  for (const l of p.commentLikes) {
    if (!inWindow(l.created_at) || l.user_id === user.id) continue;
    const c = commentsById.get(l.comment_id);
    if (!c || !isMe(c.author)) continue;
    addLike('c:' + c.id, { kind: 'comment', song: songTitle(songIdOf(c)), at: c.timestamp_sec, text: c.content }, l.user_id);
  }
  for (const l of p.replyLikes) {
    if (!inWindow(l.created_at) || l.user_id === user.id) continue;
    const c = commentsById.get(l.comment_id);
    if (!c) continue;
    const r = parseReplies(c.replies)[l.reply_index];
    if (!r || !isMe(r.author)) continue;
    addLike('r:' + c.id + ':' + l.reply_index, { kind: 'reply', song: songTitle(songIdOf(c)), at: c.timestamp_sec, text: r.text }, l.user_id);
  }
  const likes = [...likeGroups.values()].map((g) => ({ ...g, likers: [...g.likers] }));

  // ── Personal: new replies in threads I'm part of ─────────────────────────
  const threads = [];
  for (const c of p.comments) {
    const replies = parseReplies(c.replies);
    const mine = isMe(c.author);
    const myReplies = replies.filter((r) => isMe(r.author));
    if (!mine && !myReplies.length) continue;
    // Only replies that came after I joined the thread (replies without a timestamp count as old).
    const joinedAt = mine ? -Infinity : Math.min(...myReplies.map((r) => ts(r.created_at) || -Infinity));
    const fresh = replies.filter((r) => inWindow(r.created_at) && !isMe(r.author) && ts(r.created_at) > joinedAt);
    if (!fresh.length) continue;
    threads.push({
      song: songTitle(songIdOf(c)),
      at: c.timestamp_sec,
      mine,
      text: c.content,
      replies: fresh.map((r) => ({ author: r.author, text: r.text })),
      latest: Math.max(...fresh.map((r) => ts(r.created_at))),
    });
  }
  threads.sort((a, b) => b.latest - a.latest);

  return { user, since, until, newSongs: newSongs.map((s) => s.title), newVersions, commentActivity, likes, threads };
}

export function isEmpty(d) {
  return !d.newSongs.length && !d.newVersions.length && !d.commentActivity.length && !d.likes.length && !d.threads.length;
}

// ── Formatting ─────────────────────────────────────────────────────────────
export function ft(s) {
  s = Number(s);
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

export function snippet(text, n = 60) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

export function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
}

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

function fmtDate(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));
}

function capped(items, max, render) {
  const lines = items.slice(0, max).map(render);
  if (items.length > max) lines.push('…and ' + (items.length - max) + ' more');
  return lines;
}

/** Returns the WhatsApp text, or null when there's nothing to report. */
export function formatDigest(d, { appUrl } = {}) {
  if (isEmpty(d)) return null;
  const out = ['🎧 *MixReview update*', '_Since ' + fmtDate(d.since) + '_'];

  if (d.newSongs.length) {
    out.push('', '*New songs (' + d.newSongs.length + ')*');
    out.push(...capped(d.newSongs, MAX_LIST, (t) => '• ' + t));
  }
  if (d.newVersions.length) {
    out.push('', '*New versions (' + d.newVersions.length + ')*');
    out.push(...capped(d.newVersions, MAX_LIST, (v) => '• ' + v.song + ' — ' + v.label));
  }
  if (d.commentActivity.length) {
    out.push('', '*New comments*');
    out.push(...capped(d.commentActivity, MAX_SONGS, (a) => {
      const parts = [];
      if (a.comments) parts.push(plural(a.comments, 'comment', 'comments'));
      if (a.replies) parts.push(plural(a.replies, 'reply', 'replies'));
      return '• ' + a.song + ': ' + parts.join(', ');
    }));
  }

  if (d.likes.length || d.threads.length) {
    out.push('', '*For you, ' + d.user.name + '*');
    out.push(...capped(d.likes, MAX_PERSONAL, (l) =>
      '❤️ ' + joinNames(l.likers) + ' liked your ' + l.kind + ' on ' + l.song + ' (' + ft(l.at) + '): "' + snippet(l.text, 50) + '"'));
    out.push(...capped(d.threads, MAX_PERSONAL, (t) => {
      const n = t.replies.length;
      const where = t.mine ? 'your comment' : 'a thread you replied to';
      const head = '💬 ' + plural(n, 'new reply', 'new replies') + ' on ' + where + ' on ' + t.song + ' (' + ft(t.at) + ')';
      const shown = t.replies.slice(-2).map((r) => '    ↳ ' + r.author + ': "' + snippet(r.text, 60) + '"');
      return [head, ...shown].join('\n');
    }));
  }

  if (appUrl) out.push('', appUrl);
  return out.join('\n');
}

// ── GLOBALS ────────────────────────────────────────────────────────────────
var sb = null;
var songs = [], vers = {}, comms = [], curSong = null, curVer = null, curTs = 0, raf = null;
var currentUser  = null;        // { id, name, color }
var likesMap     = {};          // commentId → [{ userId, name, color }]
var replyLikesMap= {};          // "commentId-ri" → [{ userId, name, color }]
var readSet      = new Set();   // comment IDs the current user has marked as read
var unreadCounts = {};          // songId → unread count

var audio = document.getElementById('audio');
var ICON_PLAY  = '<polygon points="6,3 20,12 6,21"/>';
var ICON_PAUSE = '<rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/>';
var ICON_HEART = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
var ICON_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 1h4v2H4V4h4L9 3zm-3 5h12l-1 13H7L6 8zm5 2v9h1v-9h-1zm3 0v9h1v-9h-1z"/></svg>';
var ICON_CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';

var confirmCallback = null, dragIdx = null, waveCache = {};
var waveAnimFrame = null, waveAnimStart = null, WAVE_ANIM_DURATION = 600;
var autoPlayNext = false;

const SUPABASE_URL = "https://nxmodpianwotdvpixjqp.supabase.co";
const SUPABASE_KEY = "sb_publishable_iBK75q4oIOK25ph5VWJRYg_lxz2QwEM";

// ── KEYBOARD ────────────────────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.code !== 'Space') return;
  var tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.preventDefault(); togglePlay();
});

// ── WAVEFORM HOVER ──────────────────────────────────────────────────────────
var waveWrap     = document.getElementById('waveform-wrap');
var hoverLine    = document.getElementById('hover-line');
var hoverTooltip = document.getElementById('hover-tooltip');

waveWrap.addEventListener('mousemove', function(e) {
  if (!audio.duration) return;
  var r = waveWrap.getBoundingClientRect(), x = e.clientX - r.left;
  hoverLine.style.left = x + 'px'; hoverLine.style.display = 'block';
  var tipX = Math.min(Math.max(x, 28), r.width - 28);
  hoverTooltip.style.left = tipX + 'px';
  hoverTooltip.textContent = ft((x / r.width) * audio.duration);
  hoverTooltip.style.display = 'block';
});
waveWrap.addEventListener('mouseleave', function() { hoverLine.style.display = 'none'; hoverTooltip.style.display = 'none'; });
waveWrap.addEventListener('click', function(e) { seekTo(e); });

// ── INIT ────────────────────────────────────────────────────────────────────
window.onload = async function() {
  handleMobileUI();
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  var sessionRes = await sb.auth.getSession();
  var session = sessionRes.data && sessionRes.data.session;
  if (session) {
    var ok = await loadProfile(session.user.id);
    if (ok) {
      await loadAllReads();
      loadSongs();
    }
  } else {
    document.getElementById('login-modal').classList.add('open');
    setTimeout(function(){ document.getElementById('login-email').focus(); }, 200);
  }
};

// ── AUTH ────────────────────────────────────────────────────────────────────
async function doLogin() {
  var email    = document.getElementById('login-email').value.trim();
  var password = document.getElementById('login-password').value;
  var errEl    = document.getElementById('login-error');
  var btn      = document.getElementById('login-btn');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Enter your email and password.'; return; }
  btn.textContent = 'Signing in…'; btn.disabled = true;
  var res = await sb.auth.signInWithPassword({ email: email, password: password });
  btn.textContent = 'Sign In'; btn.disabled = false;
  if (res.error) { errEl.textContent = res.error.message; return; }
  var ok = await loadProfile(res.data.user.id);
  if (!ok) { errEl.textContent = 'Profile not found. Contact Charles.'; return; }
  document.getElementById('login-modal').classList.remove('open');
  await loadAllReads();
  loadSongs();
}

async function doLogout() {
  await sb.auth.signOut();
  location.reload();
}

async function loadProfile(uid) {
  var res = await sb.from('profiles').select('*').eq('id', uid).single();
  if (res.error || !res.data) return false;
  currentUser = res.data;
  // Topbar chip
  var av = document.getElementById('user-avatar');
  av.style.background = currentUser.color;
  av.textContent = getInitials(currentUser.name);
  document.getElementById('user-name').textContent = currentUser.name;
  return true;
}

// Load ALL comment_reads for the current user once at startup
async function loadAllReads() {
  var res = await sb.from('comment_reads').select('comment_id').eq('user_id', currentUser.id);
  readSet = new Set((res.data || []).map(function(r){ return r.comment_id; }));
}

// ── SONGS ───────────────────────────────────────────────────────────────────
async function loadSongs() {
  var r = await sb.from('songs').select('*').order('sort_order',{ascending:true}).order('created_at');
  if (r.error) { toast('Error: '+r.error.message); return; }
  songs = r.data || [];
  await loadUnreadCounts();
  renderSongs();
  if (songs.length && !curSong) pickSong(songs[0].id);
}

async function loadUnreadCounts() {
  if (!currentUser) return;
  // Fetch all comments not authored by this user
  var res = await sb.from('comments').select('id, song_id, author').neq('author', currentUser.name);
  unreadCounts = {};
  for (var i = 0; i < (res.data || []).length; i++) {
    var c = res.data[i];
    if (!readSet.has(c.id)) {
      unreadCounts[c.song_id] = (unreadCounts[c.song_id] || 0) + 1;
    }
  }
}

async function fetchVersions(sid) {
  var r = await sb.from('versions').select('*').eq('song_id',sid).order('created_at',{ascending:true});
  vers[sid] = r.data || []; return vers[sid];
}

async function loadComms(vid) {
  var commRes = await sb.from('comments').select('*').eq('version_id',vid).order('timestamp_sec');
  comms = commRes.data || [];

  if (!comms.length) {
    likesMap = {}; replyLikesMap = {};
    renderComments(); renderDots(); return;
  }

  var ids = comms.map(function(c){ return c.id; });

  // Fetch likes and reply-likes in parallel
  var results = await Promise.all([
    sb.from('comment_likes').select('comment_id, user_id, profiles(name, color)').in('comment_id', ids),
    sb.from('reply_likes').select('comment_id, reply_index, user_id, profiles(name, color)').in('comment_id', ids)
  ]);

  // Build likesMap
  likesMap = {};
  (results[0].data || []).forEach(function(l) {
    if (!likesMap[l.comment_id]) likesMap[l.comment_id] = [];
    likesMap[l.comment_id].push({ userId: l.user_id, name: l.profiles.name, color: l.profiles.color });
  });

  // Build replyLikesMap
  replyLikesMap = {};
  (results[1].data || []).forEach(function(l) {
    var key = l.comment_id + '-' + l.reply_index;
    if (!replyLikesMap[key]) replyLikesMap[key] = [];
    replyLikesMap[key].push({ userId: l.user_id, name: l.profiles.name, color: l.profiles.color });
  });

  renderComments();
  renderDots();
}

function renderSongs() {
  var el = document.getElementById('songlist');
  if (!songs.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">🎵</div>No songs yet.<br>Upload one to get started.</div>';
    return;
  }
  el.innerHTML = songs.map(function(s, i) {
    var uc = unreadCounts[s.id] || 0;
    var badge = uc > 0
      ? '<span class="unread-badge">'+uc+'</span>'
      : '';
    return '<div class="sitem'+(curSong&&curSong.id===s.id?' active':'')+'" draggable="true" data-id="'+s.id+'" '
      +'ondragstart="dragStart(event,'+i+')" ondragover="dragOver(event)" ondrop="dragDrop(event,'+i+')" ondragleave="dragLeave(event)" '
      +'onclick="handleSongClick(event,\''+s.id+'\')">'
      +'<span class="drag-handle">&#8942;&#8942;</span>'
      +'<div class="sthumb">&#127925;</div>'
      +'<div class="stitle">'+esc(s.title)+'</div>'
      +badge
      +'</div>';
  }).join('');
}

function renderVersionPills(vl, activeId) {
  var el = document.getElementById('version-pills');
  if (!vl||!vl.length) { el.innerHTML=''; return; }
  el.innerHTML = vl.map(function(v){
    return '<button class="vpill'+(v.id===activeId?' active':'')+'" onclick="loadVersion(\''+v.id+'\')">'+esc(v.label)+'</button>';
  }).join('');
}

function handleSongClick(e,sid) { if(e.target.classList.contains('drag-handle')) return; pickSong(sid); }

function dragStart(e,i) { dragIdx=i; e.dataTransfer.effectAllowed='move'; }
function dragOver(e)    { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dragLeave(e)   { e.currentTarget.classList.remove('drag-over'); }
function dragDrop(e,toIdx) {
  e.currentTarget.classList.remove('drag-over');
  if (dragIdx===null||dragIdx===toIdx) return;
  var moved=songs.splice(dragIdx,1)[0]; songs.splice(toIdx,0,moved); dragIdx=null; renderSongs();
  songs.forEach(function(s,i){ sb.from('songs').update({sort_order:i}).eq('id',s.id); });
}

async function pickSong(sid) {
  curSong = songs.find(function(s){return s.id===sid;});
  var vl = await fetchVersions(sid); renderSongs();
  document.getElementById('ptitle').textContent = curSong.title;
  document.getElementById('ptitle').style.color = '';
  audio.currentTime = 0;
  if (vl.length) { renderVersionPills(vl,vl[vl.length-1].id); loadVersion(vl[vl.length-1].id); }
  else renderVersionPills([],null);
}

async function loadVersion(vid) {
  if (!curSong) return;
  var vl = vers[curSong.id]||[];
  var v = vl.find(function(x){return x.id===vid;}); if(!v) return;
  var savedTime  = (autoPlayNext || !(audio.duration && !isNaN(audio.duration))) ? 0 : audio.currentTime;
  var wasPlaying = !audio.paused || autoPlayNext;
  curVer = v;
  audio.src = cdnUrl(v.file_url);
  audio.load();
  if (!wasPlaying) setPlayIcon(false);
  document.getElementById('dlbtn').style.display = 'flex';
  renderVersionPills(vl, vid); clearWaveCanvas();
  // Restore playhead to saved position once the new audio is ready
  audio.addEventListener('loadedmetadata', function() {
    var t = Math.min(savedTime, audio.duration);
    audio.currentTime = t;
    curTs = t;
    document.getElementById('stampbadge').textContent = '@' + ft(t);
    document.getElementById('playhead').style.left = (t / audio.duration * 100) + '%';
    document.getElementById('timedisplay').textContent = ft(t) + ' / ' + ft(audio.duration);
    redrawWaveProgress();
  }, {once: true});
  // Resume playback (or start for autoPlayNext) once the browser is ready
  if (wasPlaying) {
    autoPlayNext = false;
    audio.addEventListener('canplay', function(){ audio.play(); setPlayIcon(true); tick(); }, {once:true});
  }
  if (waveCache[vid]) animateWaveIn(waveCache[vid]);
  else { setWaveLoading(true); decodeAndCacheWave(vid, v.file_url); }
  await loadComms(vid);
}

function isMobile() { return window.innerWidth < 900; }
window.addEventListener('resize', handleMobileUI);
function handleMobileUI() { document.getElementById('right-panel').style.display = isMobile()?'none':'flex'; }

function cdnUrl(supabaseUrl) {
  var filename = supabaseUrl.split('/audio/')[1];
  return 'https://mix-review.charlesdupont1997.workers.dev/audio-proxy/'+filename;
}

// ── WAVEFORM ────────────────────────────────────────────────────────────────
function setPlayIcon(p) { document.getElementById('play-icon').innerHTML = p ? ICON_PAUSE : ICON_PLAY; }
function setWaveLoading(on) {
  var el=document.getElementById('wave-loading'); el.textContent=on?'Analysing waveform...':''; el.style.display=on?'flex':'none';
}
function clearWaveCanvas() {
  if(waveAnimFrame){cancelAnimationFrame(waveAnimFrame);waveAnimFrame=null;}
  var c=document.getElementById('wcanvas'),ctx=c.getContext('2d');
  c.width=c.offsetWidth; c.height=c.offsetHeight; ctx.clearRect(0,0,c.width,c.height);
}
async function decodeAndCacheWave(vid,url) {
  try {
    var stored = localStorage.getItem('wave_'+vid);
    if (stored) {
      waveCache[vid] = new Float32Array(JSON.parse(stored));
      setWaveLoading(false);
      if (curVer && curVer.id === vid) animateWaveIn(waveCache[vid]);
      return;
    }
    var resp = await fetch(cdnUrl(url)), buf=await resp.arrayBuffer();
    var actx=new(window.AudioContext||window.webkitAudioContext)();
    var abuf=await actx.decodeAudioData(buf); actx.close();
    var BARS=250,nc=abuf.numberOfChannels,len=abuf.length;
    var chs=[]; for(var ch=0;ch<nc;ch++) chs.push(abuf.getChannelData(ch));
    var STEP=4,ml=Math.ceil(len/STEP),mono=new Float32Array(ml);
    for(var i=0;i<ml;i++){var idx=i*STEP,s=0;for(var ch=0;ch<nc;ch++)s+=chs[ch][idx];mono[i]=s/nc;}
    var spb=Math.floor(ml/BARS),peaks=new Float32Array(BARS);
    for(var b=0;b<BARS;b++){var st=b*spb,rs=0;for(var s=0;s<spb;s++){var vv=mono[st+s];rs+=vv*vv;}peaks[b]=Math.sqrt(rs/spb);}
    var mp=0; for(var i=0;i<BARS;i++) if(peaks[i]>mp) mp=peaks[i];
    if(mp>0) for(var i=0;i<BARS;i++) peaks[i]/=mp;
    waveCache[vid]=peaks; setWaveLoading(false);
    localStorage.setItem('wave_'+vid, JSON.stringify(Array.from(peaks)));
    if(curVer&&curVer.id===vid) animateWaveIn(peaks);
  } catch(err) { setWaveLoading(false); console.warn('Wave decode failed:',err); drawWaveFallback(); }
}
function easeOutCubic(t){return 1-Math.pow(1-t,3);}
function animateWaveIn(peaks) {
  if(waveAnimFrame){cancelAnimationFrame(waveAnimFrame);waveAnimFrame=null;}
  waveAnimStart=null;
  function frame(ts){
    if(!waveAnimStart) waveAnimStart=ts;
    var prog=Math.min((ts-waveAnimStart)/WAVE_ANIM_DURATION,1);
    drawWaveFromPeaks(peaks,easeOutCubic(prog));
    if(prog<1) waveAnimFrame=requestAnimationFrame(frame); else waveAnimFrame=null;
  }
  waveAnimFrame=requestAnimationFrame(frame);
}
function drawWaveFromPeaks(peaks,scale) {
  if(scale===undefined) scale=1;
  var c=document.getElementById('wcanvas'),ctx=c.getContext('2d');
  c.width=c.offsetWidth; c.height=c.offsetHeight;
  var bars=peaks.length,bw=c.width/bars,midY=c.height/2;
  var pf=(curVer&&audio.duration)?(audio.currentTime/audio.duration):0;
  ctx.clearRect(0,0,c.width,c.height);
  for(var i=0;i<bars;i++){
    var h=Math.max(2*scale,peaks[i]*c.height*0.88*scale);
    var played=(i/bars<pf);
    var alpha=0.5+peaks[i]*0.5;
    ctx.fillStyle=played?'rgba(255,77,109,'+alpha+')':'rgba(58,69,96,'+(0.4+peaks[i]*0.6)+')';
    var gap=bw>3?1.5:0.5;
    ctx.fillRect(i*bw+gap,midY-h/2,bw-gap*2,h);
  }
}
function drawWaveFallback() {
  var c=document.getElementById('wcanvas'),ctx=c.getContext('2d');
  c.width=c.offsetWidth; c.height=c.offsetHeight;
  var bars=180,bw=c.width/bars; ctx.clearRect(0,0,c.width,c.height);
  for(var i=0;i<bars;i++){var h=(0.15+Math.random()*0.75)*c.height;ctx.fillStyle='rgba(42,51,71,0.8)';ctx.fillRect(i*bw+1,(c.height-h)/2,bw-2,h);}
}
function redrawWaveProgress() {
  if(!waveAnimFrame&&curVer&&waveCache[curVer.id]) drawWaveFromPeaks(waveCache[curVer.id],1);
}

// ── PLAYER ──────────────────────────────────────────────────────────────────
function togglePlay() {
  if(!audio.src||audio.src===location.href){toast('No audio loaded');return;}
  if(audio.paused){audio.play();setPlayIcon(true);tick();}
  else{audio.pause();setPlayIcon(false);cancelAnimationFrame(raf);}
}
audio.onended = function() {
  setPlayIcon(false); cancelAnimationFrame(raf);
  if(!curSong||songs.length<2) return;
  var idx=songs.findIndex(function(s){return s.id===curSong.id;});
  if(idx>=0&&idx<songs.length-1){autoPlayNext=true;pickSong(songs[idx+1].id);}
};
function tick() { if(!audio.paused){updateHead();raf=requestAnimationFrame(tick);} }

function updateHead() {
  if(!audio.duration) return;
  var p=audio.currentTime/audio.duration;
  document.getElementById('playhead').style.left=(p*100)+'%';
  document.getElementById('timedisplay').textContent=ft(audio.currentTime)+' / '+ft(audio.duration);
  document.getElementById('stampbadge').textContent='@'+ft(audio.currentTime);
  curTs=audio.currentTime; redrawWaveProgress();
}

function seekTo(e) {
  var r=waveWrap.getBoundingClientRect(),p=(e.clientX-r.left)/r.width;
  if(audio.duration){audio.currentTime=p*audio.duration;curTs=audio.currentTime;document.getElementById('stampbadge').textContent='@'+ft(curTs);updateHead();}
}
function downloadVersion() {
  if(!curVer||!curSong){toast('No version loaded');return;}
  var ext=curVer.file_url.split('.').pop().split('?')[0]||'mp3';
  var a=document.createElement('a');
  a.href=cdnUrl(curVer.file_url);
  a.download=curSong.title+' - '+curVer.label+'.'+ext;
  a.target='_blank';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  toast('Download started!');
}

// ── COMMENTS ────────────────────────────────────────────────────────────────
function renderMainTop() {
  var el = document.getElementById('main-top');
  var unreadInView = comms.filter(function(c){ return !readSet.has(c.id) && c.author !== currentUser.name; }).length;
  if (unreadInView > 0) {
    el.innerHTML = '<span style="color:var(--blue);">'+unreadInView+' unread</span>'
      +'<button class="btn ghost" style="padding:3px 9px;font-size:11px;" onclick="markAllRead()">Mark all as read</button>';
  } else {
    el.innerHTML = '';
  }
}

function renderComments() {
  var el = document.getElementById('comments-area');
  if (!comms.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">💬</div>No comments yet</div>';
    renderMainTop(); return;
  }
  var active   = comms.filter(function(c){return !c.resolved;});
  var resolved = comms.filter(function(c){return c.resolved;});
  var html = active.map(function(c){return renderCard(c);}).join('');
  if (resolved.length) {
    html += '<div class="section-divider">Resolved ('+resolved.length+')</div>';
    html += resolved.map(function(c){return renderCard(c);}).join('');
  }
  el.innerHTML = html;
  renderMainTop();
}

function renderCard(c) {
  var isUnread = !readSet.has(c.id) && currentUser && c.author !== currentUser.name;
  var likes    = likesMap[c.id] || [];
  var liked    = currentUser ? likes.some(function(l){return l.userId===currentUser.id;}) : false;
  var likeNames= likes.map(function(l){return l.name;}).join(', ');
  var color    = getAuthorColor(c.author);
  var replies  = c.replies ? JSON.parse(c.replies) : [];

  var repliesHtml = '';
  if (replies.length) {
    repliesHtml = '<div class="replies">' + replies.map(function(r, ri) {
      var rKey   = c.id + '-' + ri;
      var rLikes = replyLikesMap[rKey] || [];
      var rLiked = currentUser ? rLikes.some(function(l){return l.userId===currentUser.id;}) : false;
      var rNames = rLikes.map(function(l){return l.name;}).join(', ');
      var rColor = getAuthorColor(r.author);
      return '<div class="reply-card" id="reply-'+c.id+'-'+ri+'">'
        +'<div class="reply-top">'
          +'<div style="display:flex;align-items:center;gap:6px;">'
            +'<div style="width:20px;height:20px;border-radius:50%;background:'+rColor+';display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#0f1117;flex-shrink:0;">'+getInitials(r.author)+'</div>'
            +'<span class="reply-author" style="color:'+rColor+';">'+esc(r.author)+'</span>'
          +'</div>'
          +'<span class="reply-date">'+new Date(r.created_at).toLocaleDateString()+'</span>'
        +'</div>'
        +'<textarea class="reply-edit-input" id="redit-'+c.id+'-'+ri+'">'+escVal(r.text)+'</textarea>'
        +'<div class="reply-text" id="rtext-'+c.id+'-'+ri+'">'+esc(r.text)+'</div>'
        +'<div class="reply-actions">'
          +'<button class="cact-btn'+(rLiked?' liked':'')+(rLikes.length>0?' has-likes':'')+'" onclick="likeReply(\''+c.id+'\','+ri+')" title="'+(rNames||'No likes yet')+'">'+ICON_HEART+(rLikes.length>0?'<b style="font-size:12px;margin-left:1px;">'+rLikes.length+'</b>':'')+'</button>'
          +'<button class="cact-btn" onclick="editReply(\''+c.id+'\','+ri+')">Edit</button>'
          +'<button class="cact-btn" style="display:none" id="rsave-'+c.id+'-'+ri+'" onclick="saveReply(\''+c.id+'\','+ri+')">💾 Save</button>'
          +'<button class="cact-btn reply-delete-btn" onclick="deleteReply(\''+c.id+'\','+ri+')" title="Delete reply">'+ICON_TRASH+'</button>'
        +'</div>'
      +'</div>';
    }).join('') + '</div>';
  }

  return '<div class="ccard'+(c.resolved?' resolved':'')+(isUnread?' unread':'')+'" id="cc-'+c.id+'">'
    +'<div class="ccard-top">'
      +'<div style="display:flex;align-items:center;gap:8px;">'
        +'<div style="width:28px;height:28px;border-radius:50%;background:'+color+';display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#0f1117;flex-shrink:0;">'+getInitials(c.author)+'</div>'
        +'<span class="cauthor" style="color:'+color+';">'+esc(c.author)+(c.resolved?' <span style="color:var(--green);font-size:11px;">resolved</span>':'')+'</span>'
      +'</div>'
      +'<span class="ctsbadge" onclick="jumpTo('+c.timestamp_sec+')">@'+ft(c.timestamp_sec)+'</span>'
    +'</div>'
    +'<textarea class="cedit-input" id="cedit-'+c.id+'">'+escVal(c.content)+'</textarea>'
    +'<div class="ctext" id="ctext-'+c.id+'">'+esc(c.content)+'</div>'
    +'<div class="cdate">'+new Date(c.created_at).toLocaleDateString()+'</div>'
    +'<div class="cactions">'
      +'<button class="cact-btn'+(liked?' liked':'')+(likes.length>0?' has-likes':'')+'" onclick="toggleLike(\''+c.id+'\')" title="'+(likeNames||'No likes yet')+'">'+ICON_HEART+(likes.length>0?'<b style="font-size:12px;margin-left:1px;">'+likes.length+'</b>':'')+'</button>'
      +'<button class="cact-btn" onclick="toggleReplyBox(\''+c.id+'\')" title="Reply">Reply</button>'
      +'<button class="cact-btn" id="cedit-btn-'+c.id+'" onclick="editComment(\''+c.id+'\')">Edit</button>'
      +'<button class="cact-btn" style="display:none" id="csave-btn-'+c.id+'" onclick="saveComment(\''+c.id+'\')">💾 Save</button>'
      +'<button class="cact-btn '+(c.resolved?'resolved-btn':'')+'" onclick="toggleResolve(\''+c.id+'\')">'+(c.resolved?'Unresolve':'Resolve')+'</button>'
      +(isUnread?'<button class="cact-btn mark-read-btn" onclick="markRead(\''+c.id+'\')" title="Mark as read">'+'Mark as read</button>':'')
      +'<button class="cact-btn delete-btn" onclick="deleteComment(\''+c.id+'\')" title="Delete comment">'+ICON_TRASH+'</button>'
    +'</div>'
    +repliesHtml
    +'<div class="reply-input-wrap" id="replybox-'+c.id+'">'
      +'<div class="reply-input-row">'
        +'<input type="text" placeholder="Write a reply…" id="rtext-input-'+c.id+'" onkeydown="if(event.key===\'Enter\')submitReply(\''+c.id+'\')" style="flex:1"/>'
        +'<button class="btn sm" onclick="submitReply(\''+c.id+'\')">Post</button>'
      +'</div>'
    +'</div>'
  +'</div>';
}

function renderDots() {
  var el=document.getElementById('cdots'); el.innerHTML='';
  if(!audio.duration){audio.addEventListener('loadedmetadata',renderDots,{once:true});return;}
  comms.filter(function(c){return !c.resolved;}).forEach(function(c){
    var d=document.createElement('div'); d.className='cdot';
    // Unread dots shown in blue
    if (!readSet.has(c.id) && currentUser && c.author !== currentUser.name) {
      d.style.background = 'var(--blue)';
      d.style.boxShadow = '0 0 6px rgba(96,165,250,0.6)';
    }
    d.style.left=(c.timestamp_sec/audio.duration*100)+'%';
    d.title='@'+ft(c.timestamp_sec)+' · '+c.author+': '+c.content.slice(0,40)+(c.content.length>40?'…':'');
    d.onclick=function(e){e.stopPropagation();jumpTo(c.timestamp_sec);};
    el.appendChild(d);
  });
}

function jumpTo(s) {
  audio.currentTime=s; curTs=s;
  document.getElementById('stampbadge').textContent='@'+ft(s);
  updateHead();
  if(audio.paused){audio.play();setPlayIcon(true);tick();}
}

// ── LIKES ────────────────────────────────────────────────────────────────────
async function toggleLike(cid) {
  if (!currentUser) return;
  var likes    = likesMap[cid] || [];
  var alreadyLiked = likes.some(function(l){return l.userId===currentUser.id;});

  if (alreadyLiked) {
    await sb.from('comment_likes').delete().eq('comment_id', cid).eq('user_id', currentUser.id);
    likesMap[cid] = likes.filter(function(l){return l.userId!==currentUser.id;});
  } else {
    await sb.from('comment_likes').insert({ comment_id: cid, user_id: currentUser.id });
    if (!likesMap[cid]) likesMap[cid] = [];
    likesMap[cid].push({ userId: currentUser.id, name: currentUser.name, color: currentUser.color });
  }
  renderComments();
}

async function likeReply(cid, ri) {
  if (!currentUser) return;
  var key   = cid + '-' + ri;
  var likes = replyLikesMap[key] || [];
  var alreadyLiked = likes.some(function(l){return l.userId===currentUser.id;});

  if (alreadyLiked) {
    await sb.from('reply_likes').delete().eq('comment_id', cid).eq('reply_index', ri).eq('user_id', currentUser.id);
    replyLikesMap[key] = likes.filter(function(l){return l.userId!==currentUser.id;});
  } else {
    await sb.from('reply_likes').insert({ comment_id: cid, reply_index: ri, user_id: currentUser.id });
    if (!replyLikesMap[key]) replyLikesMap[key] = [];
    replyLikesMap[key].push({ userId: currentUser.id, name: currentUser.name, color: currentUser.color });
  }
  renderComments();
}

// ── READ TRACKING ────────────────────────────────────────────────────────────
async function markRead(cid) {
  if (!currentUser || readSet.has(cid)) return;
  var res = await sb.from('comment_reads').insert({ user_id: currentUser.id, comment_id: cid });
  if (res.error) { console.warn('markRead error', res.error); return; }
  readSet.add(cid);
  if (curSong) unreadCounts[curSong.id] = Math.max(0, (unreadCounts[curSong.id] || 0) - 1);
  renderComments();
  renderSongs();
  renderDots();
}

async function markAllRead() {
  if (!currentUser) return;
  var unreadComments = comms.filter(function(c){ return !readSet.has(c.id) && c.author !== currentUser.name; });
  if (!unreadComments.length) return;
  var inserts = unreadComments.map(function(c){ return { user_id: currentUser.id, comment_id: c.id }; });
  var res = await sb.from('comment_reads').upsert(inserts, { onConflict: 'user_id,comment_id' });
  if (res.error) { console.warn('markAllRead error', res.error); return; }
  unreadComments.forEach(function(c){ readSet.add(c.id); });
  if (curSong) unreadCounts[curSong.id] = Math.max(0, (unreadCounts[curSong.id] || 0) - unreadComments.length);
  renderComments();
  renderSongs();
  renderDots();
}

// ── COMMENT ACTIONS ─────────────────────────────────────────────────────────
function deleteComment(cid) {
  var c = comms.find(function(x){return x.id===cid;});
  if (!c) return;
  showConfirm(
    'Delete comment?',
    'Permanently delete the comment by "'+c.author+'" at '+ft(c.timestamp_sec)+'?',
    async function() {
      comms = comms.filter(function(x){return x.id!==cid;});
      renderComments(); renderDots();
      var r = await sb.from('comments').delete().eq('id',cid);
      if (r.error) {
        comms.push(c);
        comms.sort(function(a,b){return a.timestamp_sec-b.timestamp_sec;});
        renderComments(); renderDots();
        toast('Error deleting comment'); console.error(r.error); return;
      }
      // Remove from unread count if it was unread
      if (!readSet.has(cid) && curSong && c.author !== currentUser.name) {
        unreadCounts[curSong.id] = Math.max(0, (unreadCounts[curSong.id]||0) - 1);
        renderSongs();
      }
      readSet.delete(cid);
      toast('Comment deleted');
    }
  );
}

function deleteReply(cid, ri) {
  var c=comms.find(function(x){return x.id===cid;}); if(!c) return;
  var replies=c.replies?JSON.parse(c.replies):[];
  var r=replies[ri]; if(!r) return;
  showConfirm('Delete reply?', 'Permanently delete the reply by "'+r.author+'"?', async function() {
    replies.splice(ri,1);
    var upd=await sb.from('comments').update({replies:JSON.stringify(replies)}).eq('id',cid);
    if(upd.error){toast('Error: '+upd.error.message);return;}
    c.replies=JSON.stringify(replies); renderComments(); toast('Reply deleted');
  });
}

function toggleReplyBox(cid) {
  var box=document.getElementById('replybox-'+cid); if(!box) return;
  box.style.display=box.style.display==='block'?'none':'block';
  if(box.style.display==='block') document.getElementById('rtext-input-'+cid).focus();
}

async function submitReply(cid) {
  if (!currentUser) return;
  var c=comms.find(function(x){return x.id===cid;}); if(!c) return;
  var text=document.getElementById('rtext-input-'+cid).value.trim();
  if(!text){toast('Enter a reply');return;}
  var replies=c.replies?JSON.parse(c.replies):[];
  replies.push({author: currentUser.name, text: text, likes:0, likedBy:'', created_at:new Date().toISOString()});
  await sb.from('comments').update({replies:JSON.stringify(replies)}).eq('id',cid);
  c.replies=JSON.stringify(replies);
  document.getElementById('rtext-input-'+cid).value='';
  renderComments();
}

function editComment(cid) {
  document.getElementById('ctext-'+cid).classList.add('editing');
  var ed=document.getElementById('cedit-'+cid); ed.style.display='block'; ed.focus();
  document.getElementById('cedit-btn-'+cid).style.display='none';
  document.getElementById('csave-btn-'+cid).style.display='inline-flex';
}
async function saveComment(cid) {
  var newText=document.getElementById('cedit-'+cid).value.trim(); if(!newText) return;
  await sb.from('comments').update({content:newText}).eq('id',cid);
  var c=comms.find(function(x){return x.id===cid;}); if(c) c.content=newText;
  renderComments();
}

function editReply(cid,ri) {
  document.getElementById('rtext-'+cid+'-'+ri).style.display='none';
  document.getElementById('redit-'+cid+'-'+ri).style.display='block';
  document.getElementById('rsave-'+cid+'-'+ri).style.display='inline-flex';
}
async function saveReply(cid,ri) {
  var c=comms.find(function(x){return x.id===cid;}); if(!c) return;
  var replies=c.replies?JSON.parse(c.replies):[];
  var newText=document.getElementById('redit-'+cid+'-'+ri).value.trim(); if(!newText) return;
  replies[ri].text=newText;
  await sb.from('comments').update({replies:JSON.stringify(replies)}).eq('id',cid);
  c.replies=JSON.stringify(replies); renderComments();
}

async function toggleResolve(cid) {
  var c=comms.find(function(x){return x.id===cid;}); if(!c) return;
  var newVal=!c.resolved;
  await sb.from('comments').update({resolved:newVal}).eq('id',cid);
  c.resolved=newVal; renderComments(); renderDots();
}

async function postComment() {
  if(!sb){toast('Not connected');return;}
  if(!curVer){toast('Select a song first');return;}
  if(!currentUser){toast('Not signed in');return;}
  var t=document.getElementById('ctext').value.trim();
  if(!t){toast('Enter a comment');return;}
  var r=await sb.from('comments').insert({
    song_id: curSong.id,
    version_id: curVer.id,
    author: currentUser.name,
    timestamp_sec: curTs,
    content: t,
    likes: 0,
    likedBy: '',
    resolved: false,
    replies: '[]'
  });
  if(r.error){toast('Error: '+r.error.message);return;}
  document.getElementById('ctext').value='';
  toast('Comment posted ✓');
  await loadComms(curVer.id);
}

// ── LOOP REGION ──────────────────────────────────────────────────────────────
var loopStart  = null;
var loopEnd    = null;
var isDragging = false;
var dragStartX = null;

// Draw the yellow loop overlay inside drawWaveFromPeaks — patch it
var _origDrawWave = drawWaveFromPeaks;
drawWaveFromPeaks = function(peaks, scale) {
  _origDrawWave(peaks, scale);
  if (loopStart !== null && loopEnd !== null && audio.duration) {
    var c   = document.getElementById('wcanvas');
    var ctx = c.getContext('2d');
    var x1  = (loopStart / audio.duration) * c.width;
    var x2  = (loopEnd   / audio.duration) * c.width;
    // Filled region
    ctx.fillStyle = 'rgba(251,191,36,0.13)';
    ctx.fillRect(x1, 0, x2 - x1, c.height);
    // Left edge
    ctx.fillStyle = 'rgba(251,191,36,0.9)';
    ctx.fillRect(x1, 0, 2, c.height);
    // Right edge
    ctx.fillRect(x2 - 2, 0, 2, c.height);
  }
};

// Also patch animateWaveIn so the loop redraws after animation
var _origAnimateWaveIn = animateWaveIn;
animateWaveIn = function(peaks) {
  _origAnimateWaveIn(peaks);
};

// Mouse events on the waveform for drag-to-set-loop
waveWrap.addEventListener('mousedown', function(e) {
  if (!audio.duration) return;
  isDragging  = true;
  dragStartX  = e.clientX;
  var r       = waveWrap.getBoundingClientRect();
  var p       = (e.clientX - r.left) / r.width;
  loopStart   = p * audio.duration;
  loopEnd     = loopStart;
  updateLoopUI();
  e.preventDefault(); // prevent text selection while dragging
});

window.addEventListener('mousemove', function(e) {
  if (!isDragging || !audio.duration) return;
  var r    = waveWrap.getBoundingClientRect();
  var p    = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
  var time = p * audio.duration;
  // Always keep loopStart < loopEnd
  if (time < loopStart) {
    // dragging left — swap
    loopEnd   = loopStart;
    loopStart = time;
  } else {
    loopEnd = time;
  }
  updateLoopUI();
  redrawWaveProgress();
});

window.addEventListener('mouseup', function(e) {
  if (!isDragging) return;
  isDragging = false;
  // If the drag was too small (< 0.3s), treat it as a plain seek and clear loop
  if (loopEnd - loopStart < 0.3) {
    clearLoop();
    seekTo(e); // fall through to normal seek
  } else {
    // Snap playhead to loop start and begin playing
    audio.currentTime = loopStart;
    curTs = loopStart;
    updateHead();
    if (audio.paused) { audio.play(); setPlayIcon(true); tick(); }
    updateLoopUI();
  }
});

// Override seekTo so plain clicks still work when not dragging
var _origSeekTo = seekTo;
seekTo = function(e) {
  if (isDragging) return; // handled by mouseup
  _origSeekTo(e);
};

// Loop enforcement — hook into the existing tick/updateHead cycle
var _origUpdateHead = updateHead;
updateHead = function() {
  _origUpdateHead();
  if (loopStart !== null && loopEnd !== null && audio.duration) {
    if (audio.currentTime >= loopEnd) {
      audio.currentTime = loopStart;
    }
  }
};

function updateLoopUI() {
  var bar   = document.getElementById('loop-bar');
  var label = document.getElementById('loop-range-label');
  if (loopStart !== null && loopEnd !== null && loopEnd - loopStart >= 0.3) {
    bar.classList.add('show');
    label.textContent = ft(loopStart) + ' – ' + ft(loopEnd);
  } else {
    bar.classList.remove('show');
  }
  redrawWaveProgress();
}

function clearLoop() {
  loopStart = null;
  loopEnd   = null;
  updateLoopUI();
}

// Escape to clear loop
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') clearLoop();
});

// Clear loop when changing version
var _origLoadVersion = loadVersion;
loadVersion = function(vid) {
  clearLoop();
  return _origLoadVersion(vid);
};

// ── CONFIRM MODAL ────────────────────────────────────────────────────────────
function showConfirm(title,msg,cb) {
  document.getElementById('confirm-title').textContent=title;
  document.getElementById('confirm-msg').textContent=msg;
  confirmCallback=cb;
  document.getElementById('confirm-modal').classList.add('open');
}
function closeConfirm(){document.getElementById('confirm-modal').classList.remove('open');confirmCallback=null;}
function runConfirm() { var cb=confirmCallback; closeConfirm(); if(cb) cb(); }

// ── UPLOAD ───────────────────────────────────────────────────────────────────
var umode='song';
function openModal(m) {
  if(!sb){toast('Not connected');return;}
  umode=m;
  document.getElementById('modal-title').textContent=m==='song'?'Upload New Song':'Add Version to Song';
  document.getElementById('mf-song').style.display=m==='song'?'block':'none';
  document.getElementById('mf-version').style.display=m==='version'?'block':'none';
  if(m==='version') document.getElementById('m-song-sel').innerHTML=songs.map(function(s){return '<option value="'+s.id+'">'+esc(s.title)+'</option>';}).join('');
  document.getElementById('uprog').textContent='';
  document.getElementById('m-file').value='';
  document.getElementById('modal').classList.add('open');
}
function closeModal(){document.getElementById('modal').classList.remove('open');}

async function doUpload() {
  if(!sb) return;
  var file=document.getElementById('m-file').files[0]; if(!file){toast('Select a file');return;}
  var prog=document.getElementById('uprog');
  if(umode==='song'){
    var title=document.getElementById('m-song-title').value.trim(); if(!title){prog.textContent='Enter a title';return;}
    var dup=songs.find(function(s){return s.title.toLowerCase()===title.toLowerCase();});
    if(dup){prog.textContent='A song with this name already exists.';return;}
  } else {
    var sid2=document.getElementById('m-song-sel').value;
    var lbl=document.getElementById('m-ver-label').value.trim(); if(!lbl){prog.textContent='Enter a version label';return;}
    var dupVer=(vers[sid2]||[]).find(function(v){return v.label.toLowerCase()===lbl.toLowerCase();});
    if(dupVer){prog.textContent='A version with this label already exists for this song.';return;}
  }
  prog.textContent='Uploading…';
  var fname=Date.now()+'_'+file.name.replace(/\s+/g,'_');
  var up=await sb.storage.from('audio').upload(fname,file);
  if(up.error){prog.textContent='Failed: '+up.error.message;return;}
  var fileUrl=sb.storage.from('audio').getPublicUrl(fname).data.publicUrl;
  if(umode==='song'){
    var verLabel=document.getElementById('m-song-ver').value.trim()||'V1';
    var sid='song_'+Date.now();
    var sr=await sb.from('songs').insert({id:sid,title:title,sort_order:songs.length});
    if(sr.error){prog.textContent='Error: '+sr.error.message;return;}
    await sb.from('versions').insert({id:'v_'+Date.now(),song_id:sid,label:verLabel,file_url:fileUrl});
    prog.textContent='Song uploaded! 🎉'; await loadSongs();
  } else {
    var vr=await sb.from('versions').insert({id:'v_'+Date.now(),song_id:sid2,label:lbl,file_url:fileUrl});
    if(vr.error){prog.textContent='Error: '+vr.error.message;return;}
    prog.textContent='Version added! ✓';
    if(curSong&&curSong.id===sid2){var vl3=await fetchVersions(sid2);renderVersionPills(vl3,curVer?curVer.id:vl3[0].id);}
  }
  setTimeout(closeModal,1400);
}

// ── UTILS ────────────────────────────────────────────────────────────────────
var AUTHOR_COLORS = {
  'Charles':'#60a5fa','charles':'#60a5fa',
  'Jeoffrey':'#4ade80','jeoffrey':'#4ade80',
  'Remon':'#fbbf24','remon':'#fbbf24',
  'Nikil':'#a78bfa','nikil':'#a78bfa',
  'Maurizio':'#f472b6','maurizio':'#f472b6',
  'Mixup':'#888888'
};
function getAuthorColor(name) { return AUTHOR_COLORS[name] || '#9ba3b8'; }
function getInitials(name) {
  return String(name).split(' ').map(function(w){return w[0]||'';}).join('').toUpperCase().slice(0,2);
}
function ft(s){if(!s||isNaN(s))return '0:00';return Math.floor(s/60)+':'+(Math.floor(s%60)<10?'0':'')+Math.floor(s%60);}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function escVal(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},3000);}
window.addEventListener('resize',function(){if(curVer&&waveCache[curVer.id])drawWaveFromPeaks(waveCache[curVer.id],1);});
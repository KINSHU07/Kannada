(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LANGS = { en: 'English', kn: 'ಕನ್ನಡ', hi: 'हिन्दी', ta: 'தமிழ்', te: 'తెలుగు', ml: 'മലയാളം' };
const SR = { en: 'en-IN', kn: 'kn-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', ml: 'ml-IN' };
const INTERVALS = [0, 1, 3, 7, 14, 30];   // Leitner boxes -> days until next review

// ---------------------------------------------------------------- state
const LS = 'nk:v2';
const DEFAULTS = { saved: {}, srs: {}, xp: 0, streak: { n: 0, last: '' }, set: { roman: true, slow: false, theme: 'auto' } };
let S = (() => {
  try { const o = JSON.parse(localStorage.getItem(LS) || '{}'); return { ...DEFAULTS, ...o, set: { ...DEFAULTS.set, ...o.set }, streak: { ...DEFAULTS.streak, ...o.streak } }; }
  catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
})();
const persist = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch { /* private mode */ } };
const day = (d = new Date()) => d.toLocaleDateString('en-CA');
function addXP(n) {
  S.xp += n;
  const t = day();
  if (S.streak.last !== t) { S.streak.n = S.streak.last === day(new Date(Date.now() - 864e5)) ? S.streak.n + 1 : 1; S.streak.last = t; }
  persist();
}
let DATA = { scenarios: [], all: [] };
let installEvt = null, audio = null;
const pf = { s: 'all', q: '' };
const tv = { src: 'en', tgt: 'kn', text: '', res: null, busy: false };
const ch = { scn: null, turns: [], sugg: [], busy: false, err: '' };
const sc = { busy: false, res: null, preview: '' };
const pr = { queue: [], i: 0, flip: false, right: 0, on: false };

// ---------------------------------------------------------------- utils
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3000); }
async function api(path, body, form) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const opt = body === undefined ? { signal: ctl.signal } : { method: 'POST', signal: ctl.signal, headers: form ? {} : { 'Content-Type': 'application/json' }, body: form ? body : JSON.stringify(body) };
    const r = await fetch(path, opt);
    if (!r.ok) {
      let m = 'Something went wrong. Please try again.';
      try { const d = (await r.json()).detail; if (typeof d === 'string') m = d; else if (r.status === 422) m = 'Please check your input.'; } catch { /* non-JSON */ }
      throw new Error(m);
    }
    return await r.json();
  } catch (e) { throw e.name === 'AbortError' ? new Error('The request took too long. Please try again.') : e; }
  finally { clearTimeout(timer); }
}
const ttsUrl = (text, lang = 'kn', slow = false) => `/api/tts?text=${encodeURIComponent(text)}&lang=${lang}&slow=${slow}`;
async function speak(text, { lang = 'kn', slow = S.set.slow } = {}) {
  try { if (audio) audio.pause(); audio = new Audio(ttsUrl(text, lang, slow)); await audio.play(); }
  catch {
    if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(text); u.lang = SR[lang] || 'kn-IN'; u.rate = slow ? .6 : .9; speechSynthesis.speak(u); }
    else toast('Audio is unavailable right now.');
  }
}
function listen(lang, cb) {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!R) return toast('Voice input works in Chrome or Edge.');
  const r = new R(); r.lang = SR[lang] || 'en-IN'; r.interimResults = false;
  r.onresult = e => cb(e.results[0][0].transcript);
  r.onerror = () => toast('I could not hear you. Try again.');
  toast('Listening…'); r.start();
}
function localLookup(text) {
  const n = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/).filter(Boolean);
  const q = new Set(n(text)); let best = null, bs = 0;
  for (const p of DATA.all) { const c = new Set(n(p.en)); const k = [...q].filter(w => c.has(w)).length / Math.max(q.size, c.size, 1); if (k > bs) { bs = k; best = p; } }
  return bs >= .5 ? best : null;
}
const errCard = () => ch.err ? `<div class="card err">${esc(ch.err)} <a href="/api/diagnose" target="_blank" rel="noopener"><u>Run diagnostics</u></a></div>` : '';
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------------------------------------------------------------- components
const attrs = p => `data-kn="${esc(p.kn)}" data-en="${esc(p.en || '')}" data-tr="${esc(p.tr || '')}"`;
const ib = (act, ic, label, p, on = false) => `<button class="icon-btn${on ? ' on' : ''}" data-act="${act}" ${attrs(p)} aria-label="${label}" title="${label}">${ic}</button>`;
const tools = p => { const s = !!S.saved[p.kn]; return ib('play', '▶', 'Play', p) + ib('slow', '🐢', 'Play slowly', p) + ib('show', '📣', 'Show this to someone', p) + ib('save', s ? '★' : '☆', s ? 'Remove from saved' : 'Save', p, s); };
const phraseCard = p => `<article class="card"><div class="kn" lang="kn">${esc(p.kn)}</div>${S.set.roman && p.tr ? `<div class="rom">${esc(p.tr)}</div>` : ''}<div class="en">${esc(p.en || '')}</div>${p.tip ? `<div class="tip">💡 ${esc(p.tip)}</div>` : ''}<div class="row acts">${tools(p)}</div></article>`;
const dueCards = () => { const t = day(), seen = [], fresh = []; for (const p of DATA.all) { const s = S.srs[p.kn]; if (!s) fresh.push(p); else if (s.due <= t) seen.push(p); } return [...shuffle(seen), ...shuffle(fresh).slice(0, 8)].slice(0, 12); };

// ---------------------------------------------------------------- views
const VIEWS = {
  home() {
    const lvl = Math.floor(S.xp / 100) + 1, pct = S.xp % 100, pod = DATA.all[Math.floor(Date.now() / 864e5) % DATA.all.length];
    return `<section class="card hero"><div><div class="hi" lang="kn">ನಮಸ್ಕಾರ!</div><div class="mut">Kannada for real life. Learn it, then use it today.</div>
      <div class="stats"><span class="pill">🔥 ${S.streak.n}-day streak</span><span class="pill">⭐ Level ${lvl}</span><span class="pill">★ ${Object.keys(S.saved).length} saved</span></div></div>
      <div class="ring" data-p="${pct}" aria-label="${pct} of 100 XP to next level"><b>${pct}</b><small>XP</small></div></section>
      <h2>Phrase of the day</h2>${phraseCard(pod)}
      <h2>Survive in…</h2><div class="grid2">${DATA.scenarios.map(s => `<a class="card scn" href="#phrases?s=${s.id}"><span class="ico">${s.icon}</span><b>${esc(s.title)}</b><small>${esc(s.intro)}</small></a>`).join('')}</div>
      <h2>Do more</h2><div class="grid2">
        <a class="card qa" href="#talk"><span class="ico">💬</span><b>Talk to a local</b><small>AI roleplay</small></a>
        <a class="card qa" href="#scan"><span class="ico">📷</span><b>Scan a sign</b><small>Read &amp; translate</small></a>
        <a class="card qa" href="#translate"><span class="ico">🎙️</span><b>Say it in Kannada</b><small>Voice or text</small></a>
        <a class="card qa" href="#practice"><span class="ico">🧠</span><b>Practice</b><small>${dueCards().length} cards ready</small></a></div>
      <h2>Settings</h2><section class="card">
        <label class="toggle">Show Roman-letter pronunciation<input type="checkbox" data-set="roman" ${S.set.roman ? 'checked' : ''}></label>
        <label class="toggle">Slow audio by default<input type="checkbox" data-set="slow" ${S.set.slow ? 'checked' : ''}></label>
        <label class="toggle">Theme<select data-set="theme" class="auto"><option value="auto">Auto</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
        <div class="row acts"><button class="btn" data-act="offline">⬇ Save audio for offline</button><button class="btn" data-act="install" id="install" hidden>＋ Install app</button><button class="btn" data-act="reset">Reset progress</button></div>
        <p class="mut"><small>Progress is stored on this device only. No account, no tracking.</small></p></section>`;
  },
  phrases(p) {
    if (p.get('s')) pf.s = p.get('s');
    const chips = [['all', 'All'], ...DATA.scenarios.map(s => [s.id, `${s.icon} ${s.title}`]), ['saved', '★ Saved']];
    return `<h1>Phrasebook</h1><div class="chips" role="tablist">${chips.map(([id, l]) => `<button class="chip${pf.s === id ? ' on' : ''}" data-act="scn" data-id="${id}">${esc(l)}</button>`).join('')}</div>
      <input id="q" type="search" placeholder="Search English, Kannada or pronunciation" value="${esc(pf.q)}" aria-label="Search phrases"><div id="plist">${plist()}</div>`;
  },
  translate() {
    const opts = sel => Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v}</option>`).join('');
    return `<h1>Say it in Kannada</h1><form id="trf"><div class="langs"><select id="src" aria-label="From">${opts(tv.src)}</select><button type="button" class="icon-btn" data-act="swap" aria-label="Swap languages">⇄</button><select id="tgt" aria-label="To">${opts(tv.tgt)}</select></div>
      <textarea id="tin" maxlength="300" placeholder="Type or tap the mic: “Where can I get filter coffee?”" aria-label="Text to translate">${esc(tv.text)}</textarea>
      <div class="row acts"><button class="icon-btn" type="button" data-act="mic" data-target="tin" aria-label="Speak">🎤</button><button class="btn primary" type="submit" ${tv.busy ? 'disabled' : ''}>${tv.busy ? 'Translating…' : 'Translate'}</button></div></form><div id="tres">${tres()}</div>`;
  },
  talk() {
    if (!ch.scn) return `<h1>Talk to a local</h1><p class="mut">Pick a situation. An AI character speaks to you in Kannada. Reply in English, Kannada or by voice, and see how to say it.</p><div class="grid2">${DATA.scenarios.map(s => `<button class="card scn" data-act="start" data-id="${s.id}" ${ch.busy ? 'disabled' : ''}><span class="ico">${s.icon}</span><b>${esc(s.title)}</b></button>`).join('')}</div>${ch.busy ? '<p class="mut">Connecting…</p>' : ''}${errCard()}`;
    const t = x => ({ kn: x.kn, en: x.en, tr: x.roman });
    return `<h1>${esc(DATA.scenarios.find(s => s.id === ch.scn)?.title || '')} <button class="btn" data-act="restart">New</button></h1>
      ${ch.turns.map(x => x.role === 'user'
        ? `<div class="bubble me"><div class="kn" lang="kn">${esc(x.kn)}</div>${S.set.roman && x.roman ? `<div class="rom">${esc(x.roman)}</div>` : ''}<div class="en">${esc(x.en)}</div><div class="row acts">${ib('play', '▶', 'Play', t(x))}</div></div>`
        : `<div class="bubble"><div class="kn" lang="kn">${esc(x.kn)}</div>${S.set.roman && x.roman ? `<div class="rom">${esc(x.roman)}</div>` : ''}<div class="en">${esc(x.en)}</div><div class="row acts">${ib('play', '▶', 'Play', t(x))}${ib('slow', '🐢', 'Slowly', t(x))}</div></div>`).join('')}
      ${ch.busy ? '<p class="mut">Thinking…</p>' : ''}${errCard()}
      ${ch.sugg.length ? `<h2>Try saying</h2>${ch.sugg.map(s => `<div class="sugg"><button class="chip" data-act="send" data-en="${esc(s.en)}"><span class="kn k11" lang="kn">${esc(s.kn)}</span><br><small>${esc(s.en)}</small></button>${ib('play', '▶', 'Hear it', { kn: s.kn, en: s.en, tr: s.roman })}</div>`).join('')}` : ''}
      <form id="chatf" class="row acts"><input id="cin" maxlength="300" placeholder="Reply in English or ಕನ್ನಡ" aria-label="Your reply" class="fill" autocomplete="off"><button class="icon-btn" type="button" data-act="mic" data-target="cin" aria-label="Speak in English">🎤</button><button class="icon-btn" type="button" data-act="mic" data-target="cin" data-lang="kn" aria-label="Speak in Kannada">ಕ</button><button class="btn primary" ${ch.busy ? 'disabled' : ''}>Send</button></form>`;
  },
  scan() {
    return `<h1>Scan a sign</h1><p class="mut">Photograph a board, menu or notice in Kannada. We read it, translate it and say it aloud.</p>
      <label class="btn primary inl">📷 Take or choose a photo<input id="file" type="file" accept="image/*" capture="environment" hidden></label>
      ${sc.preview ? `<img src="${sc.preview}" alt="Your photo" class="photo">` : ''}
      ${sc.busy ? '<p class="mut">Reading the sign…</p>' : ''}
      ${sc.res ? (sc.res.found ? phraseCard({ kn: sc.res.text, tr: sc.res.roman, en: sc.res.english }) : '<div class="card err">I could not find readable Kannada. Try a closer, brighter, straighter photo.</div>') : ''}`;
  },
  practice() {
    if (!pr.on) { const n = dueCards().length; return `<h1>Practice</h1><div class="card"><p>Spaced repetition: phrases you miss come back sooner, ones you know come back later.</p><p><b>${n}</b> cards ready today.</p><button class="btn primary" data-act="pstart" ${n ? '' : 'disabled'}>Start session</button></div>`; }
    if (pr.i >= pr.queue.length) return `<h1>Session complete 🎉</h1><div class="card"><p>You knew <b>${pr.right}</b> cards. +${pr.right * 10} XP.</p><button class="btn primary" data-act="pstart">Another round</button></div>`;
    const c = pr.queue[pr.i];
    return `<h1>Practice</h1><div class="bar"><i data-w="${Math.round(100 * pr.i / pr.queue.length)}"></i></div>
      <div class="card"><small class="mut">How do you say this in Kannada?</small><div class="kn k16">${esc(c.en)}</div>
      ${pr.flip ? `<div class="kn" lang="kn">${esc(c.kn)}</div>${S.set.roman ? `<div class="rom">${esc(c.tr || '')}</div>` : ''}<div class="row acts">${ib('play', '▶', 'Play', c)}</div>` : ''}</div>
      <div class="row">${pr.flip ? '<button class="btn primary" data-act="grade" data-ok="1">✅ Got it</button><button class="btn" data-act="grade" data-ok="0">🔁 Again</button>' : '<button class="btn primary" data-act="flip">Show answer</button>'}</div>`;
  },
};
function plist() {
  let list = pf.s === 'saved' ? Object.values(S.saved) : pf.s === 'all' ? DATA.all : DATA.all.filter(p => p.scenario === pf.s);
  const q = pf.q.trim().toLowerCase();
  if (q) list = list.filter(p => `${p.en} ${p.tr} ${p.kn}`.toLowerCase().includes(q));
  return list.length ? list.map(phraseCard).join('') : `<div class="card mut">${pf.s === 'saved' ? 'Tap ☆ on any phrase to save it here.' : 'No phrases found.'}</div>`;
}
function tres() {
  const r = tv.res; if (!r) return '';
  const badge = `<small class="mut">${esc(LANGS[r.src])} → ${esc(LANGS[r.tgt])} · ${esc(r.provider)}</small>`;
  if (r.tgt === 'kn') return badge + phraseCard({ kn: r.text, tr: r.roman, en: r.in });
  return badge + `<article class="card"><div class="kn" lang="${r.tgt}">${esc(r.text)}</div><div class="row acts"><button class="icon-btn" data-act="playl" data-kn="${esc(r.text)}" data-lang="${r.tgt}" aria-label="Play">▶</button></div></article>`;
}

// ---------------------------------------------------------------- router
function render(keep) {
  const [name, qs] = location.hash.slice(1).split('?'), route = VIEWS[name] ? name : 'home';
  const y = window.scrollY;
  $('#view').innerHTML = DATA.all.length ? VIEWS[route](new URLSearchParams(qs || '')) : '<div class="card err">Could not load phrases. Check your connection and <button class="btn" data-act="retry">retry</button>.</div>';
  $$('.tabs a').forEach(a => a.setAttribute('aria-current', a.getAttribute('href') === '#' + route ? 'page' : 'false'));
  $$('.ring').forEach(r => r.style.setProperty('--p', r.dataset.p));
  $$('.bar i').forEach(b => { b.style.width = b.dataset.w + '%'; });
  const th = $('select[data-set=theme]'); if (th) th.value = S.set.theme;
  const ins = $('#install'); if (ins && installEvt) ins.hidden = false;
  window.scrollTo(0, keep ? y : 0);
}
function applyTheme() { const dark = matchMedia('(prefers-color-scheme: dark)').matches; document.documentElement.dataset.theme = S.set.theme === 'auto' ? (dark ? 'dark' : 'light') : S.set.theme; }

// ---------------------------------------------------------------- actions
function showBig(d) {
  $('#show-kn').textContent = d.kn; $('#show-rom').textContent = d.tr || ''; $('#show-en').textContent = d.en || '';
  $('#show').hidden = false; $('#show').dataset.kn = d.kn;
  if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  speak(d.kn);
}
async function doTranslate() {
  const text = tv.text.trim(); if (!text) return toast('Please type or say something first.');
  if (tv.src === tv.tgt) return toast('Choose two different languages.');
  tv.busy = true; render(true);
  try {
    const r = await api('/api/translate', { text, source: tv.src, target: tv.tgt });
    tv.res = { ...r, src: tv.src, tgt: tv.tgt, in: text }; addXP(3);
  } catch (e) {
    const hit = tv.src === 'en' && tv.tgt === 'kn' ? localLookup(text) : null;
    if (hit) { tv.res = { text: hit.kn, roman: hit.tr, provider: 'offline phrasebook', src: 'en', tgt: 'kn', in: text }; toast('Offline: showing the closest phrasebook match.'); }
    else { tv.res = null; toast(e.message); }
  }
  tv.busy = false; render(true);
}
async function talkSend(user) {
  if (ch.busy) return; ch.busy = true; ch.err = ''; render(true);
  try {
    const r = await api('/api/chat', { scenario: ch.scn, history: ch.turns.map(t => ({ role: t.role, en: t.en })), user: user || null });
    if (r.user) ch.turns.push({ role: 'user', ...r.user });
    ch.turns.push({ role: 'assistant', ...r.reply }); ch.sugg = r.suggestions; addXP(5);
  } catch (e) { ch.err = e.message; if (!ch.turns.length) ch.scn = null; }
  ch.busy = false; render(true);
}
function grade(ok) {
  const c = pr.queue[pr.i], s = S.srs[c.kn] || { box: 0 };
  if (ok) { s.box = Math.min(5, s.box + 1); pr.right++; addXP(10); } else { s.box = 1; pr.queue.push(c); }
  s.due = day(new Date(Date.now() + INTERVALS[s.box] * 864e5)); S.srs[c.kn] = s; persist();
  pr.i++; pr.flip = false; render(true);
}
async function downscale(file, max = 1280) {
  const bmp = await createImageBitmap(file), k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', .85));
}
async function offlinePack(btn) {
  btn.disabled = true; let n = 0;
  for (let i = 0; i < DATA.all.length; i += 4) {
    await Promise.all(DATA.all.slice(i, i + 4).map(p => fetch(ttsUrl(p.kn)).then(r => r.ok && n++).catch(() => {})));
    btn.textContent = `Saving… ${n}/${DATA.all.length}`;
  }
  btn.disabled = false; btn.textContent = '⬇ Save audio for offline'; toast(`${n} phrases saved for offline listening.`);
}
const ACT = {
  play: t => speak(t.dataset.kn), slow: t => speak(t.dataset.kn, { slow: true }), show: t => showBig(t.dataset),
  playl: t => speak(t.dataset.kn, { lang: t.dataset.lang }),
  save(t) {
    const k = t.dataset.kn;
    if (S.saved[k]) { delete S.saved[k]; toast('Removed'); } else { S.saved[k] = { kn: k, en: t.dataset.en, tr: t.dataset.tr }; addXP(2); toast('Saved ★'); }
    persist(); const on = !!S.saved[k]; t.classList.toggle('on', on); t.textContent = on ? '★' : '☆';
    if (pf.s === 'saved' && $('#plist')) $('#plist').innerHTML = plist();
  },
  scn(t) { pf.s = t.dataset.id; render(true); },
  swap() { [tv.src, tv.tgt] = [tv.tgt, tv.src]; tv.text = $('#tin').value; render(true); },
  mic(t) { const lang = t.dataset.lang || (t.dataset.target === 'tin' ? $('#src').value : 'en'); listen(lang, txt => { $('#' + t.dataset.target).value = txt; if (t.dataset.target === 'tin') tv.text = txt; }); },
  start(t) { ch.scn = t.dataset.id; ch.turns = []; ch.sugg = []; talkSend(null); },
  restart() { ch.scn = null; ch.turns = []; ch.sugg = []; render(); },
  send: t => talkSend(t.dataset.en),
  pstart() { pr.queue = dueCards(); pr.i = 0; pr.right = 0; pr.flip = false; pr.on = true; render(); },
  flip() { pr.flip = true; render(true); },
  grade: t => grade(t.dataset.ok === '1'),
  offline: t => offlinePack(t),
  install() { if (installEvt) { installEvt.prompt(); installEvt = null; } },
  reset() { if (confirm('Reset streak, XP, saved phrases and practice progress on this device?')) { S = JSON.parse(JSON.stringify(DEFAULTS)); persist(); applyTheme(); render(); } },
  retry: init,
  'show-play': () => speak($('#show').dataset.kn), 'show-close': () => { $('#show').hidden = true; },
};
document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (t && ACT[t.dataset.act]) ACT[t.dataset.act](t, e); });
document.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.id === 'trf') { tv.text = $('#tin').value; tv.src = $('#src').value; tv.tgt = $('#tgt').value; doTranslate(); }
  if (e.target.id === 'chatf') { const v = $('#cin').value.trim(); if (v) talkSend(v); }
});
document.addEventListener('input', e => { if (e.target.id === 'q') { pf.q = e.target.value; $('#plist').innerHTML = plist(); } });
document.addEventListener('change', e => {
  const k = e.target.dataset.set; if (k) { S.set[k] = k === 'theme' ? e.target.value : e.target.checked; persist(); applyTheme(); }
  if (e.target.id === 'file' && e.target.files[0]) scanFile(e.target.files[0]);
  if (e.target.id === 'src') tv.src = e.target.value; if (e.target.id === 'tgt') tv.tgt = e.target.value;
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#show').hidden = true; });
async function scanFile(file) {
  sc.busy = true; sc.res = null; sc.preview = URL.createObjectURL(file); render(true);
  try { const f = new FormData(); f.append('file', await downscale(file), 'sign.jpg'); sc.res = await api('/api/scan', f, true); addXP(5); }
  catch (e) { toast(e.message); }
  sc.busy = false; render(true);
}

// ---------------------------------------------------------------- boot
function net() { const n = $('#net'); n.textContent = navigator.onLine ? 'Online' : 'Offline mode'; n.className = 'pill ' + (navigator.onLine ? 'ok' : 'off'); }
async function init() {
  try { const d = await api('/api/scenarios'); DATA.scenarios = d.scenarios; DATA.all = d.scenarios.flatMap(s => s.phrases.map(p => ({ ...p, scenario: s.id }))); } catch { /* shows retry card */ }
  render();
}
window.addEventListener('hashchange', () => render());
window.addEventListener('online', net); window.addEventListener('offline', net);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; const b = $('#install'); if (b) b.hidden = false; });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
applyTheme(); net(); init();
})();
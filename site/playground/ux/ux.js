// Scene-based presentation layer: one question per scene, one scene on screen. It observes app.js through `pg:*` events and `window.pg.state`
// and drives the same controls a user would; it never touches models, recording or generation. Background preload and the resident-model
// policy stay in app.js (the indicator dots only read state.resident / state.loading).
const $ = (id) => document.getElementById(id);
const S = () => window.pg.state;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const ORDER = ['model', 'text', 'voice', 'ready'];
const QUESTION = {model: 'Which model do you want to use?', text: 'What do you want to say?', voice: 'Now, let us hear your voice.', ready: 'You’re all set. Ready to generate?'};
const ui = {cur: 'model', chosen: false, langTouched: false, transition: null, recordedLang: null, refApproved: null};
const sceneEl = (n) => $('scene-' + n);
const LANGNAME = {en: 'English', zh: 'Mandarin'};

// ---- user-perceived waiting (what the product is judged on) --------------------------------------------------------------------------------------------
// One record per model confirmation: selection → ready, selection → Generate click, what was still left to wait at Generate, and the inference itself.
// No percentages are shown anywhere: states are Preparing (with elapsed seconds) and Ready.
const J = {model: null, tSelect: null, tReady: null, tGen: null, runs: []};
const now = () => performance.now();
const secs = (ms) => ms == null ? '—' : (ms / 1000).toFixed(1) + ' s';
function journeyStart(id) {
  const m = window.pg.models.find((x) => x.id === id); Object.assign(J, {model: id, tSelect: now(), tReady: S().resident.has(m) ? now() : null, wasResident: S().resident.has(m), tGen: null});
  renderWait();
}
function renderWait() {
  const t = $('waitTable').tBodies[0], last = J.runs[J.runs.length - 1], cur = J.model ? [
    ['Model confirmed', J.model + (J.wasResident ? ' (already loaded in this session)' : '')],
    ['Selection → Model Ready', J.tReady == null ? 'still preparing…' : secs(J.tReady - J.tSelect)]] : [];
  const rows = [...cur, ...(last ? [['Selection → Generate click', secs(last.selectToGenerate)], ['Model ready before the click?', last.readyBeforeGenerate ? 'yes' : 'no'], ['Extra waiting at Generate', secs(last.waitAtGenerate)],
    ['Inference (generation)', secs(last.inference)], ['Click → result', secs(last.clickToResult)], ['Perceived wait = extra wait at Generate + inference', secs(last.waitAtGenerate + last.inference)]] : [])];
  t.innerHTML = rows.length ? rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') : '<tr><td>No model selected yet</td><td></td></tr>';
}
let tick = 0;
function paintChipState() {   // honest status: Preparing with elapsed seconds (no invented percentage), or nothing when ready
  const m = S().model, loading = m && S().loading.has(m), el = $('chipState');
  const st = loading && S().loadStage?.get(m.id), bytes = st?.kind === 'files' ? ` · ${st.got} MB ${S().savedAtLoad?.get(m.id) ? 'read' : window.vsStore?.production ? 'downloaded' : 'loaded'}` : '';
  if (loading && J.tSelect != null) { el.textContent = `· preparing ${Math.round((now() - J.tSelect) / 1000)} s${bytes}`; if (!tick) tick = setInterval(() => { paintChipState(); if (ui.cur === 'ready') syncReady(); }, 1000); }
  else { el.textContent = ''; if (tick) { clearInterval(tick); tick = 0; } }
}

// ---- language-aware reference recommendation ----------------------------------------------------------------------------------------------------------
function detectLang(t) {   // by letter counts; deliberately conservative: a few words of the other language already make it "mixed" (the user then chooses)
  const cjk = (t.match(/[\u3400-\u9fff]/g) || []).length, lat = (t.match(/[A-Za-z]/g) || []).length, n = cjk + lat;
  if (n < 2) return 'unknown'; const share = cjk / n; return share >= .97 ? 'zh' : share <= .03 ? 'en' : 'mixed';   // any real amount of both scripts counts as mixed
}
function recommendation() {   // {target, rec}: rec = the reading language to suggest, or null when the user must choose
  const target = detectLang($('text').value), langs = S().model?.languages || [];
  let rec = target === 'zh' ? 'zh' : target === 'en' ? 'en' : null;
  if (rec === 'zh' && !langs.includes('zh')) rec = 'en';   // Chatterbox speaks English only
  return {target, rec};
}
function languageNote(recorded) {   // text for scene 3 (hint) and scene 4 (warning); recorded = language of the existing recording or null
  const {target, rec} = recommendation(), chosen = recorded || $('recLang').value, T = {zh: 'Mandarin', en: 'English'};
  if (target === 'zh' && rec === 'en') return {kind: 'warn', text: `${tileName(S().tile?.id)} speaks English only, so an English passage is used; your Mandarin message will probably not sound right with it.`};
  if (rec) return rec === chosen ? {kind: 'ok', text: `Your message is ${T[target]}, and you are reading ${T[chosen]}: the best match for your voice.`}
    : {kind: 'warn', text: `Your message is ${T[target]} but ${recorded ? 'your recording is' : 'you are reading'} ${T[chosen]}. Cross-language voice cloning is experimental and may sound less like you${recorded ? ' — record again in ' + T[rec] + ' for the best match' : ''}.`};
  if (target === 'mixed') return {kind: 'info', text: 'Your message mixes Mandarin and English. Choose the language you will read in; how well the voice carries across languages is experimental.'};
  return {kind: 'info', text: 'Choose the language you want to read in. A passage in the same language as your message gives the closest match.'};
}

const hasCJK = (t) => /[㐀-鿿]/.test(t);

// ---- view transitions --------------------------------------------------------------------------------------------------------------------------------
// One helper for every DOM change that should animate. Rejections from skipped/overlapping transitions are expected and swallowed; `after` always runs.
function vt(update, after) {
  if (!document.startViewTransition || reduced.matches) { update(); after && after(); return null; }
  ui.transition?.skipTransition();
  const t = ui.transition = document.startViewTransition(update);
  t.ready.catch(() => {}); t.updateCallbackDone.catch(() => {});
  t.finished.catch(() => {}).finally(() => { if (ui.transition === t) ui.transition = null; after && after(); });
  return t;
}

// ---- scene navigation -----------------------------------------------------------------------------------------------------------------------------
const recordingOk = () => !!S().ref && !(S().model?.needsRefText && !$('refText').value.trim());
// The reference has to be reviewed again whenever the situation it was approved for changes. The user approves it by pressing Continue in scene 3. That approval
// is for one model and one language situation: "ok" (message and recording languages match) or a specific mismatch ("warn:zh" = a recording in the other language
// for a Mandarin message, ...). It is reused without another stop only for the same model AND when the situation is "ok" now or exactly the one the user accepted.
// So: another model, or a message that newly mismatches the recording, always routes through scene 3 (where the existing recording is kept, never discarded),
// while another sentence in the same language skips it. Scene 4 is only reachable from an approved situation.
const refStatus = () => { const n = languageNote(ui.recordedLang); return n.kind === 'ok' ? 'ok' : `${n.kind}:${detectLang($('text').value)}`; };
const refContext = () => ({model: S().model?.id, status: refStatus()});
const referenceApproved = () => { const a = ui.refApproved; return recordingOk() && !!a && a.model === S().model?.id && (refStatus() === 'ok' || refStatus() === a.status); };
function reachable(name) {   // the furthest scene the user may enter given what is answered so far
  if (name === 'model') return 'model';
  if (!ui.chosen) return 'model';
  if (name === 'text') return 'text';
  if (!$('text').value.trim()) return 'text';
  if (name === 'voice') return 'voice';
  return referenceApproved() ? 'ready' : 'voice';
}
function go(name, {push = true, force = false, shared = null} = {}) {
  if (!force) name = reachable(name);
  if (window.studio && window.studio.view !== 'create') {   // coming from Compare / My creations / Journey: show Create first, then the scene
    window.studio.show('create', {push: false});
    if (name === ui.cur) { if (push) history.pushState({scene: name}, '', '#' + name); syncDots(); focusScene(name); return; }
  }
  if (name === ui.cur) return;
  const from = sceneEl(ui.cur), to = sceneEl(name);
  document.documentElement.dataset.dir = ORDER.indexOf(name) < ORDER.indexOf(ui.cur) ? 'back' : 'fwd';
  if (shared) shared.before();
  vt(() => {
    from.hidden = true; delete from.dataset.active; to.hidden = false; to.dataset.active = ''; ui.cur = name;
    if (from === sceneEl('ready') && from.dataset.phase === 'result') setPhase('ready');   // coming back later starts from the summary again
    if (!document.startViewTransition || reduced.matches) { to.dataset.enter = ''; setTimeout(() => delete to.dataset.enter, 600); }
    if (shared) shared.swap();
    enter(name); syncDots(); focusScene(name);
  }, () => { if (shared) shared.after(); });
  if (push) history.pushState({scene: name}, '', '#' + name);
  $('announce').textContent = QUESTION[name];
}
function focusScene(name) {
  const t = name === 'text' ? $('text') : sceneEl(name).querySelector('h1');
  t.focus({preventScroll: true});
  if (name === 'text') { const v = $('text').value; $('text').setSelectionRange(v.length, v.length); }
}
function syncDots() {
  const i = ORDER.indexOf(ui.cur);
  document.querySelectorAll('#dots button').forEach((b, k) => {
    if (k === i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.toggleAttribute('data-done', k < i); b.disabled = reachable(ORDER[k]) !== ORDER[k];
  });
}
addEventListener('popstate', (e) => {   // Back/Forward across scenes and the studio views (Compare, My creations, Journey)
  const v = e.state?.view; if (v && v !== 'create' && window.studio) { window.studio.show(v, {push: false}); return; }
  go(e.state?.scene || 'model', {push: false});
});
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]'); if (g) { go(g.dataset.go); return; }
  if (e.target.closest('[data-back]')) go(ORDER[Math.max(0, ORDER.indexOf(ui.cur) - 1)]);
});

function enter(name) {
  if (name === 'text') { autosize(); paintExamples(); syncText(); }
  if (name === 'voice') { defaultReadingLanguage(); drawIdle(); syncVoice(); }   // (also refreshes the mismatch hint and button wording for the current model/message)
  if (name === 'ready') syncReady();
}

// ---- top bar: model indicator (shared element target) and Advanced sheet -----------------------------------------------------------------------------
function dotState(m) { return !m ? '' : S().resident.has(m) ? 'ready' : S().loading.has(m) ? 'loading' : ''; }
const STATE_TEXT = {ready: 'Ready', loading: 'Preparing…', '': 'Not loaded'};
function paintDots() {
  document.querySelectorAll('.tile').forEach((t) => { const s = dotState(window.pg.models.find((x) => x.id === t.dataset.model)); t.querySelector('.dot').dataset.s = s;
    const st = t.querySelector('.state-t'); if (st) { st.textContent = STATE_TEXT[s]; st.dataset.s = s; } });   // the card's own readiness line, from the lifecycle
  const s = dotState(S().model); $('modelChip').querySelector('.dot').dataset.s = s; $('readyDot').dataset.s = s; paintChipState();
  if (ui.cur === 'ready') syncReady();
}
const tileOf = (id) => document.querySelector(`.tile[data-model="${id}"]`);
const tileName = (id) => tileOf(id)?.querySelector('b').textContent || '';
document.addEventListener('pg:model', () => { $('chipName').textContent = tileName(S().tile?.id); paintDots(); paintExamples(); });
document.addEventListener('pg:load', (e) => { if (e.detail.id === J.model && e.detail.resident && J.tReady == null) { J.tReady = now(); renderWait(); } paintDots(); paintChipState(); });
$('modelChip').addEventListener('click', () => go('model'));
$('advBtn').addEventListener('click', () => $('advanced').showModal());
$('advClose').addEventListener('click', () => $('advanced').close());
$('advanced').addEventListener('click', (e) => { if (e.target === $('advanced')) $('advanced').close(); });   // click on the backdrop closes

// ---- scene 1: choose a model ------------------------------------------------------------------------------------------------------------------------
// A pointer click or Enter/Space confirms a card and moves on; arrow keys only move the selection inside the radio group (their synthetic
// clicks have detail 0 and no Enter/Space keydown), so browsing with the keyboard never jumps scenes.
function confirmModel(tile) {
  const why = window.pg.state.unavailable?.[tile.dataset.model];
  if (why) { window.studio?.toast(`${tile.querySelector('b').textContent} cannot run on this device. ${why}`); return; }
  document.querySelectorAll('.tile[data-picked]').forEach((t) => delete t.dataset.picked); tile.dataset.picked = '';
  const chip = $('modelChip'), first = !ui.chosen; ui.chosen = true;
  // A pointer click reaches this handler on the <label> BEFORE the radio's own `change` has switched app.js to the clicked model, so select it
  // here first; otherwise the background load would start for the previously selected model (found by the perceived-waiting test).
  const input = tile.querySelector('input'); if (!input.checked) { input.checked = true; input.dispatchEvent(new Event('change', {bubbles: true})); }
  journeyStart(tile.dataset.model);
  window.pg.preload();   // confirming the already-selected default fires no `change`, so ask app.js to start the background load explicitly
  $('chipName').textContent = tile.querySelector('b').textContent;
  setTimeout(() => go('text', {shared: {
    before: () => { tile.style.viewTransitionName = 'model-card'; if (!first) chip.style.viewTransitionName = ''; },
    swap: () => { tile.style.viewTransitionName = ''; chip.hidden = false; chip.style.viewTransitionName = 'model-card'; },
    after: () => { chip.style.viewTransitionName = ''; },
  }}), 140);
}
$('models').addEventListener('click', (e) => { const t = e.target.closest('.tile'); if (t && e.detail > 0 && !e.target.matches('input')) confirmModel(t); });
$('models').addEventListener('keydown', (e) => { const t = e.target.closest('.tile'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); t.querySelector('input').click(); confirmModel(t); } });

// ---- scene 2: what to say -----------------------------------------------------------------------------------------------------------------------------
const EXAMPLES = {en: ['Good morning! This is a quick test of my voice.', 'The weather is lovely today. Shall we take a walk?', 'Thank you for calling. How can I help you today?'],
  zh: ['大家早安，這是我的聲音測試。', '今天天氣很好，我們一起去散步吧。', '謝謝您的來電，請問有什麼可以幫您？']};   // Taiwan Traditional Chinese (zh-TW)
function paintExamples() {
  const zh = S().tile?.languages.includes('zh'), sets = zh ? [EXAMPLES.en[0], EXAMPLES.zh[0], EXAMPLES.en[2], EXAMPLES.zh[1]] : EXAMPLES.en;
  $('examples').replaceChildren(...sets.map((t) => Object.assign(document.createElement('button'), {type: 'button', textContent: t, onclick: () => insertExample(t)})));
  $('examples').querySelectorAll('button').forEach((b) => { if (/[\u3400-\u9fff]/.test(b.textContent)) b.lang = 'zh-TW'; });
}
function setText(t) { const ta = $('text'); ta.value = t; ta.dispatchEvent(new Event('input', {bubbles: true})); }
// An example never overwrites the user's own words silently: it replaces an empty box or another example directly; if there is typed text, that text is kept
// and offered back ("Restore my text") until the user edits again.
let typedBackup = null;
const isExample = (v) => Object.values(EXAMPLES).some((l) => l.includes(v));
function insertExample(t) {
  const cur = $('text').value; typedBackup = cur.trim() && !isExample(cur.trim()) ? cur : null;
  setText(t); $('exUndo').classList.toggle('hide', !typedBackup); $('text').focus();
}
$('exUndo').addEventListener('click', () => { if (typedBackup != null) { setText(typedBackup); typedBackup = null; $('exUndo').classList.add('hide'); $('text').focus(); } });
const nativeSizing = CSS.supports('field-sizing', 'content');
function autosize() {   // CSS field-sizing does this natively (Chrome/Edge/Safari 26+); the fallback measures the content and never touches the text
  const ta = $('text'); if (nativeSizing) { ta.style.height = ''; return; }
  ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * .4) + 'px';
}
function syncText() { $('textNext').disabled = !$('text').value.trim(); syncDots(); }
const advanceFromText = () => { if ($('text').value.trim()) go(referenceApproved() ? 'ready' : 'voice'); };   // same model + same language class: a recording already approved is reused without another stop
$('text').addEventListener('input', (e) => { autosize(); syncText(); if (e.isTrusted) { typedBackup = null; $('exUndo').classList.add('hide'); } });   // real typing ends the "restore" offer
let composing = false;   // IME: Enter that commits a composition must not advance (Safari reports isComposing=false on that keydown, hence keyCode 229 too)
$('text').addEventListener('compositionstart', () => { composing = true; });
$('text').addEventListener('compositionend', () => { setTimeout(() => { composing = false; }, 0); });
$('text').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || composing || e.keyCode === 229) return;
  e.preventDefault(); advanceFromText();
});
$('textNext').addEventListener('click', advanceFromText);

// ---- scene 3: your voice -----------------------------------------------------------------------------------------------------------------------------
function defaultReadingLanguage() {   // preselect the recommended reading language unless the user chose one or already recorded; mixed/unknown: leave the choice to the user
  const {rec} = recommendation(), sel = $('recLang');
  if (!ui.langTouched && !S().ref && rec && sel.value !== rec) { ui.programmatic = true; sel.value = rec; sel.dispatchEvent(new Event('change', {bubbles: true})); ui.programmatic = false; }
  paintLangHint();
}
function paintLangHint() { const n = languageNote(S().ref ? ui.recordedLang : null), el = $('langHint'); el.textContent = n.text; el.dataset.kind = n.kind; }
$('recLang').addEventListener('change', () => { if (!ui.programmatic) ui.langTouched = true; paintLangHint(); });   // only our own preselection is "programmatic"; any other change is the user's choice
function syncVoice() {
  const sc = sceneEl('voice'), has = !!S().ref, n = has ? languageNote(ui.recordedLang) : null, differs = !!n && n.kind === 'warn';
  sc.toggleAttribute('data-has-rec', has); sc.toggleAttribute('data-mismatch', differs); $('voiceNext').disabled = !recordingOk();
  $('voiceNext').querySelector('span').textContent = differs ? 'Use this recording anyway' : 'Continue';   // reusing a mismatched reference is an explicit choice, never a default
  syncDots();
}
$('refText').addEventListener('input', syncVoice);

// live, level-driven waveform while recording: each frame takes the loudest chunk reported since the previous frame
const live = {bars: [], peak: 0, raf: 0, last: 0, t0: 0};
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function fit(cv) { const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = +cv.getAttribute('height'); if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = h * dpr; } const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); return {c, w, h}; }
function drawLive() {
  const {c, w, h} = fit($('liveWave')), n = Math.floor(w / 6), gap = 6, bw = 3, mid = h / 2, hole = 52;   // leave a quiet zone behind the button
  c.clearRect(0, 0, w, h); const g = c.createLinearGradient(0, 0, w, 0); g.addColorStop(0, css('--accent')); g.addColorStop(1, css('--accent-2'));
  for (let i = 0; i < n; i++) {
    const x = i * gap + (w - n * gap) / 2, d = Math.abs(x - w / 2); if (d < hole) continue;
    const v = live.bars[live.bars.length - 1 - Math.floor(Math.abs(i - n / 2))] || 0, hh = Math.max(3, Math.min(h - 6, v * (h - 6) * (1 - d / w * .6)));
    c.globalAlpha = .35 + .65 * Math.min(1, v * 3); c.fillStyle = g; c.beginPath(); c.roundRect(x, mid - hh / 2, bw, hh, 2); c.fill();
  }
  c.globalAlpha = 1;
}
function drawIdle() { live.bars = []; drawLive(); }
function liveLoop(t) {
  if (t - live.last > 40) { live.bars.push(Math.min(1, Math.pow(live.peak, .6) * 1.25)); live.peak *= .35; live.last = t; if (live.bars.length > 400) live.bars.splice(0, 200); drawLive(); }
  $('micTime').textContent = fmt((performance.now() - live.t0) / 1000);
  live.raf = requestAnimationFrame(liveLoop);
}
document.addEventListener('pg:recstart', () => { document.body.dataset.rec = 'on'; live.bars = []; live.peak = 0; live.t0 = performance.now(); cancelAnimationFrame(live.raf); live.raf = requestAnimationFrame(liveLoop); });
document.addEventListener('pg:level', (e) => { live.peak = Math.max(live.peak, e.detail.level); document.documentElement.style.setProperty('--mic', Math.min(1, e.detail.level * 1.6).toFixed(3)); });
function recOff() { delete document.body.dataset.rec; cancelAnimationFrame(live.raf); document.documentElement.style.setProperty('--mic', 0); }
document.addEventListener('pg:recinvalid', () => { recOff(); drawIdle(); syncVoice(); });
document.addEventListener('pg:recclear', () => { ui.recordedLang = null; ui.refApproved = null; recOff(); waves.delete('recWave'); defaultReadingLanguage(); syncVoice(); drawIdle(); });   // replacing/deleting: offer the recommended language again
document.addEventListener('pg:recorded', (e) => {
  ui.recordedLang = $('recLang').value; ui.refApproved = null; paintLangHint();
  recOff(); syncVoice(); $('recDur').textContent = fmt(e.detail.sec);
  requestAnimationFrame(() => showWave($('recWave'), S().ref.samples));
  $('voiceNext').focus({preventScroll: true});
});
$('voiceNext').addEventListener('click', () => { if (!recordingOk()) return; ui.refApproved = refContext(); go('ready'); });

// ---- waveform (kept from the first draft) ----------------------------------------------------------------------------------------------------------
function peaks(samples, n) { const out = new Float32Array(n), step = Math.max(1, Math.floor(samples.length / n)); let mx = 1e-6;
  for (let i = 0; i < n; i++) { let p = 0; const a = i * step, b = Math.min(samples.length, a + step); for (let j = a; j < b; j++) p = Math.max(p, Math.abs(samples[j])); out[i] = p; mx = Math.max(mx, p); }
  return out.map((v) => Math.pow(v / mx, .7)); }
function paint(cv, pk, grow, played) {   // grow: 0..1 reveal, played: 0..1 playhead
  const {c, w, h} = fit(cv); c.clearRect(0, 0, w, h);
  const n = pk.length, gap = 3, bw = Math.max(2, (w - gap * (n - 1)) / n), g = c.createLinearGradient(0, 0, w, 0); g.addColorStop(0, css('--accent')); g.addColorStop(1, css('--accent-2'));
  for (let i = 0; i < n; i++) {
    const k = Math.min(1, Math.max(0, grow * 1.6 - (i / n) * .6)), hh = Math.max(3, pk[i] * (h - 8) * k), x = i * (bw + gap), y = (h - hh) / 2;
    const lit = played <= 0 || i / n < played;   // nothing played yet: the whole waveform is lit; while playing, bars after the playhead dim
    c.globalAlpha = lit ? 1 : .28; c.fillStyle = g; c.beginPath(); c.roundRect(x, y, bw, hh, bw / 2); c.fill();
  }
  c.globalAlpha = 1;
}
const waves = new Map();
function showWave(cv, samples) {
  const w = {cv, pk: peaks(samples, Math.max(24, Math.min(110, Math.floor((cv.clientWidth || 300) / 6)))), played: 0}; waves.set(cv.id, w);
  const t0 = performance.now(), dur = reduced.matches ? 1 : 800;
  (function tick(t) { if (waves.get(cv.id) !== w) return; const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); paint(cv, w.pk, e, w.played); if (k < 1) requestAnimationFrame(tick); })(t0);
}
const repaint = () => { waves.forEach((w) => paint(w.cv, w.pk, 1, w.played)); if (ui.cur === 'voice' && !S().ref) drawLive(); };
addEventListener('resize', repaint); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function bindPlayer(audio, btn, wave, timeEl, ownsClick) {   // playback only ever starts from a button press
  const w = () => waves.get(wave.id);
  if (ownsClick) btn.addEventListener('click', () => { if (audio.paused) { if (audio.ended) audio.currentTime = 0; audio.play(); } else audio.pause(); });
  for (const ev of ['play', 'playing']) audio.addEventListener(ev, () => btn.toggleAttribute('data-playing', true));
  for (const ev of ['pause', 'ended']) audio.addEventListener(ev, () => { btn.toggleAttribute('data-playing', false); if (ev === 'ended' && w()) { w().played = 0; paint(wave, w().pk, 1, 0); } });
  audio.addEventListener('timeupdate', () => { if (!w() || !audio.duration) return; w().played = audio.currentTime / audio.duration; paint(wave, w().pk, 1, w().played); if (timeEl) timeEl.textContent = fmt(audio.currentTime); });
  wave.addEventListener('click', (e) => { if (!audio.duration) return; const r = wave.getBoundingClientRect(); audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration; });
}
bindPlayer($('refAudio'), $('recPlay'), $('recWave'), null, false);   // recPlay's click is handled in app.js
bindPlayer($('out'), $('outPlay'), $('outWave'), $('outTime'), true);

// ---- scene 4: ready, generate, listen -----------------------------------------------------------------------------------------------------------------
function readiness() {   // truthful: what the lifecycle in app.js says right now
  const m = S().model, info = S().loadInfo[m?.id];
  if (!m) return '';
  if (S().resident.has(m)) return 'Ready';
  if (S().loading.has(m)) return `Preparing… ${J.tSelect != null && J.model === m.id ? Math.round((now() - J.tSelect) / 1000) + ' s' : ''}`.trim() + stageText(m);
  return info ? `Loads when you generate (about ${Math.round(info.wallMs / 1000)} s last time)` : 'Loads when you generate; the first time can take a while';
}
function stageText(m) {   // what the wait is made of: model files arriving (downloaded, or read back from this device) or the model starting
  const st = S().loadStage?.get(m.id); if (!st) return '';
  if (st.kind === 'start') return ' — starting the model';
  const saved = S().savedAtLoad?.get(m.id), verb = saved ? 'reading saved model files' : window.vsStore?.production ? 'downloading model files' : 'loading model files';
  return ` — ${verb}, ${st.got}${st.total ? ' / ' + st.total : ''} MB`;
}
function syncReady() {
  const txt = $('text').value.trim(), rl = ui.recordedLang, voice = S().recording ? `Your recording · ${S().recording.sec.toFixed(1)} s${rl ? ' · ' + LANGNAME[rl] + ' passage' : ''}` : '—', ready = readiness();
  $('sumModel').textContent = tileName(S().tile?.id); $('sumReady').textContent = ready; $('readyDot').dataset.s = dotState(S().model);
  $('sumText').textContent = txt; $('sumText').lang = hasCJK(txt) ? 'zh' : 'en'; $('sumVoice').textContent = voice;
  $('chipModel').textContent = `${tileName(S().tile?.id)} · ${ready}`; $('chipMsg').textContent = txt.length > 70 ? txt.slice(0, 69) + '…' : txt; $('chipVoice').textContent = voice;
  const n = S().ref ? languageNote(rl) : null; $('sumWarn').textContent = n && n.kind !== 'ok' ? n.text : ''; $('sumWarn').dataset.kind = n ? n.kind : '';
  if (document.body.dataset.gen === 'on') $('ctaLabel').textContent = S().loading.has(S().model) ? 'Preparing the model…' : 'Generating…';
}
// Scene 4 has two compositions of the same elements: "ready" (summary + Generate) and "result" (compact summary, large player, actions incl. Generate again).
// The change runs inside a View Transition with the summary, player and Generate button as named shared elements.
function setPhase(phase) {
  const sc = sceneEl('ready'), after = $('resultSec').querySelector('.after');
  sc.dataset.phase = phase;
  if (phase === 'result') { $('resultSec').classList.remove('hide'); after.insertBefore($('genRow'), $('another').nextSibling); }
  else { sc.querySelector('.scene-in').insertBefore($('genRow'), $('genNeed')); $('resultSec').classList.add('hide'); $('ctaLabel').textContent = 'Generate'; }
}
const PHASE_NAMES = [['summary', 'ready-summary'], ['player', 'ready-player'], ['generate', 'ready-cta']];
function changePhase(phase, after) {
  if (sceneEl('ready').dataset.phase === phase) { after && after(); return; }
  PHASE_NAMES.forEach(([id, n]) => { $(id).style.viewTransitionName = n; });
  vt(() => { setPhase(phase); syncReady(); }, () => { PHASE_NAMES.forEach(([id]) => { $(id).style.viewTransitionName = ''; }); after && after(); });
}
document.addEventListener('pg:generating', () => { document.body.dataset.gen = 'on'; J.tGen = now(); syncReady(); if (!S().loading.has(S().model)) $('ctaLabel').textContent = 'Generating…'; });
const genOff = (label = 'Generate') => { delete document.body.dataset.gen; $('ctaLabel').textContent = label; };
document.addEventListener('pg:genfailed', () => { genOff(sceneEl('ready').dataset.phase === 'result' ? 'Generate again' : 'Generate'); syncReady(); });
document.addEventListener('pg:generated', (e) => {
  genOff('Generate again'); $('genStatus').textContent = '';   // the revealed player says it all
  const run = window.lastRun, ready = J.tReady != null && J.tReady <= J.tGen;
  J.runs.push({model: J.model, selectToGenerate: J.tGen - J.tSelect, selectToReady: J.tReady == null ? null : J.tReady - J.tSelect, readyBeforeGenerate: ready, waitAtGenerate: run.loadThisClickMs || 0, inference: run.genMs, clickToResult: run.clickToResultMs}); renderWait();
  const gpu = /WebGPU/.test(e.detail.backend);
  $('resultCaption').textContent = `${e.detail.sec.toFixed(1)} s · generated on this device${gpu ? ', on the GPU' : ', on the CPU'} · saved in My creations`;
  $('outTime').textContent = '0:00'; $('outPlay').removeAttribute('data-playing');
  const reveal = () => { requestAnimationFrame(() => showWave($('outWave'), window.lastSamples)); $('outPlay').focus({preventScroll: true}); };
  if (sceneEl('ready').dataset.phase === 'result') { syncReady(); reveal(); return; }   // regenerating: the stage is already set
  $('resultSec').classList.add('hide');   // app.js revealed it in this same task; show it inside the transition instead
  changePhase('result', reveal);
});
$('another').addEventListener('click', () => { $('out').pause(); go('text'); setTimeout(() => $('text').select(), 50); });
$('restart').addEventListener('click', () => {
  $('out').pause();
  if (S().ref) $('recClear').click();
  setText(''); ui.chosen = false; ui.langTouched = false; ui.refApproved = null; document.querySelectorAll('.tile[data-picked]').forEach((t) => delete t.dataset.picked);
  go('model'); $('modelChip').hidden = true;   // models already loaded stay resident (app.js policy); only the journey restarts
});

// ---- boot -----------------------------------------------------------------------------------------------------------------------------------------------
sceneEl('model').dataset.active = '';
const bootView = ['compare', 'library', 'journey'].includes(location.hash.slice(1)) ? location.hash.slice(1) : null;   // deep link, opened by studio/main.js
history.replaceState({scene: 'model'}, '', '#model');
paintDots(); syncDots(); drawIdle();
// Test hook (headless regression scripts): jump to a scene the way the dots do; force skips the "answer first" rule.
// My creations → "Reuse" / "Generate again": put a creation's model, message and settings back into Create. The reference recording is never stored
// with a creation, so the usual rule applies: scene 4 only with an approved recording for this model and language, otherwise scene 3.
// `generate` presses Generate once scene 4 is reached (the user asked for it explicitly with "Generate again").
function reuse({model, text, params, generate = false}) {
  const why = window.pg.state.unavailable?.[model]; if (why) { window.studio?.toast(`That model cannot run on this device right now. ${why}`); return 'unavailable'; }
  window.pg.setParams(model, params);
  const tile = tileOf(model); if (!tile) return null; const input = tile.querySelector('input');
  if (!input.checked || S().tile?.id !== model) { input.checked = true; input.dispatchEvent(new Event('change', {bubbles: true})); }
  document.querySelectorAll('.tile[data-picked]').forEach((t) => delete t.dataset.picked); tile.dataset.picked = '';
  if (!ui.chosen || J.model !== model) { ui.chosen = true; journeyStart(model); window.pg.preload(); }
  $('chipName').textContent = tileName(model); $('modelChip').hidden = false;
  setText(text); typedBackup = null; $('exUndo').classList.add('hide');
  const target = referenceApproved() ? 'ready' : 'voice';
  go(target, {force: true}); paintDots();
  if (generate && target === 'ready') setTimeout(() => { if (!$('generate').disabled) $('generate').click(); }, reduced.matches ? 0 : 700);
  return target;
}
window.ux = {reuse, bootView, languageNote, tileName, get recordedLang() { return ui.recordedLang; }, get chosen() { return ui.chosen; }, referenceApproved, get refApproved() { return ui.refApproved; }, go: (name, force = true) => go(name, {force}), get scene() { return ui.cur; }, confirm: (id) => confirmModel(tileOf(id)), journey: J, get phase() { return sceneEl('ready').dataset.phase; }, detectLang, recommendation};

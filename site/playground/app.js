import { decodeAudio, wavBlob, hasCJK, hasLatin } from './adapters/common.js';
import zipvoice from './adapters/zipvoice.js';
import chatterbox from './adapters/chatterbox.js';
import zipvoiceHybrid from './adapters/zipvoice-hybrid.js';
import f5 from './adapters/f5.js';
import {Recorder, assess, MAX_SECONDS} from './recorder.js';
import {checkAssets} from './preflight.js';
import {PASSAGES} from './passages.js';
import {INFO, PARAM_HINT} from './studio/models-info.js';

// Public page: one "ZipVoice-Distill" tile backed by the hybrid adapter (WebGPU decoder when available, automatic WASM fallback);
// the plain WASM baseline stays registered (fallback target, "WASM only" setting) but has no tile. Research page lists every adapter.
const RESEARCH_PAGE = document.querySelector('script[data-mode]')?.dataset.mode === 'research';
const MODELS = RESEARCH_PAGE ? [zipvoice, zipvoiceHybrid, chatterbox, f5] : [zipvoiceHybrid, chatterbox, f5, zipvoice];
const TILES = RESEARCH_PAGE ? MODELS : MODELS.filter((m) => m !== zipvoice);
const tileName = (m) => !RESEARCH_PAGE && m === zipvoiceHybrid ? 'ZipVoice-Distill' : m.name;
const RESEARCH = document.querySelector('script[data-mode]')?.dataset.mode === 'research';
const PRODUCTION = !!document.querySelector('meta[name="vs-release"]');   // a deployed release (see deploy/), not the development server   // research.html only: upload + default voice
// The public page has no upload/default-voice/load controls; missing optional elements resolve to a detached stub so shared code stays simple.
const $ = (id) => document.getElementById(id) || document.createElement('div');
const q = new URLSearchParams(location.search);
const state = {model: null, tile: null, notices: [], loaded: null, ref: null, refName: null, busy: false, loadInfo: {}, errors: [], log: []};
// Lifecycle instrumentation: every worker creation/termination, model load/unload and generate call, with timestamps (Advanced -> Lifecycle).
const lc = (ev, detail) => { state.lifecycle.events.push({t: Math.round(performance.now()), ev, detail}); };
state.lifecycle = {events: [], workersCreated: 0, workersTerminated: 0, loads: {}, unloads: 0, generates: 0, sessions: 0};
// UI events for the presentation layer (ux/ux.js): the app only announces state changes, it never depends on the UI listening.
const emit = (name, detail) => document.dispatchEvent(new CustomEvent('pg:' + name, {detail}));
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {   // wrapper only observes; behaviour is unchanged
  constructor(url, opts) { super(url, opts); const name = String(url).split('/').pop(); state.lifecycle.workersCreated++; lc('worker:create', name);
    const term = this.terminate.bind(this); this.terminate = () => { state.lifecycle.workersTerminated++; lc('worker:terminate', name); term(); }; }
};
window.pg = {state, models: MODELS, preload: () => schedulePreload(0)};   // preload: lets the UI start the background load when the user confirms a model  // test hook (read-only use by playground/run_cases.mjs)
window.lastRun = null;
const log = (...a) => { state.log.push([Math.round(performance.now()), ...a]); };
const fmtS = (ms) => (ms / 1000).toFixed(2) + ' s';

function showNotice(msg) { state.notices.push(msg); log('notice', msg); $('notice').textContent = msg; }
// Errors a visitor can act on, in plain words; the original message follows for diagnosis.
// A model file that failed its sha256 check (issue #14) fails the model's download: the worker reports "Integrity check failed for <file>: …" itself,
// or, when the service worker stopped it, a network error plus the service worker's integrity-error notice (state.cacheErrors, possibly a moment later).
// Only a recent notice about a file of the model being used counts (ZipVoice's two runtimes share files), so another error is not blamed on it.
const integrity = (m) => { const w = /Integrity check failed for ([^:]+): ([^.]+)/.exec(m); if (w) return {path: w[1], message: w[2]};
  const g = state.model?.id.replace(/-hybrid$/, '');
  return (state.cacheErrors || []).findLast((x) => x.type === 'integrity-error' && x.models?.includes(g) && Date.now() - x.at < 60e3); };
const friendly = (m) => { const bad = integrity(m);
  if (bad) return `A downloaded model file (${bad.path}) failed its integrity check and was not used: ${bad.message}. Nothing damaged was kept; try again, and if it repeats, the file on the model host has changed. (Details: ${m})`;
  return /protobuf parsing failed|Can't create a session|invalid (wire|model)|magic/i.test(m)
    ? `This model’s files look damaged or incomplete. In My creations → “Model files on this device”, remove this model, then try again. (Details: ${m})` : m; };
let lastError = null;
function showError(e) { const m = e ? friendly(String(e.message || e)) : ''; lastError = e ? {e, t: Date.now()} : null; $('error').textContent = m; if (m) { state.errors.push(m); log('error', m); } }
document.addEventListener('vs:integrity', () => { if (lastError && Date.now() - lastError.t < 30e3 && !/integrity check/.test($('error').textContent)) showError(lastError.e); });   // the notice came after the error
function setBar(el, f) { el.classList.toggle('hide', f == null); if (f != null) el.value = f; }

// ---- model picker ---------------------------------------------------------------------------------------------------
const LANG_LABEL = {en: 'English', zh: '中文', 'zh+en': 'Mixed'};
const langChip = (m, l) => `<em${m.id === 'f5' && l === 'zh+en' ? ' title="Mixed-language quality has not been verified yet"' : ''}>${LANG_LABEL[l] || l}${m.id === 'f5' && l === 'zh+en' ? ' · experimental' : ''}</em>`;
// Research page: the original technical tile. Public page: the Voice Studio card (copy in studio/models-info.js): benefit, languages the card can honestly
// promise, one strength, one limitation, the live readiness state (painted by ux/ux.js from the lifecycle) and a separate "Learn more" button outside the
// radio label, so opening the details never selects or loads a model.
const researchTile = (m) => `<label class="tile" data-model="${m.id}"><input type="radio" name="model" value="${m.id}"><span class="tile-body"><span class="tile-top"><b>${tileName(m)}</b><i class="dot" aria-hidden="true"></i></span>
  <span class="tile-langs">${m.languages.map((l) => langChip(m, l)).join('')}</span>
  <small class="tile-backend">${m.backend}</small><small class="tile-size">${m.size}</small>${m.knownIssues.map((k) => `<small class="issue ${k.level}">${k.level === 'pending' ? '⏳' : '⚠'} ${k.short || k.lang}</small>`).join('')}</span></label>`;
const publicCard = (m) => { const c = INFO[m.id];
  return `<div class="card" data-card="${m.id}"><label class="tile" data-model="${m.id}"><input type="radio" name="model" value="${m.id}" aria-describedby="cardBenefit-${m.id}"><span class="tile-body">
  <span class="tile-top"><b>${tileName(m)}</b><span class="tile-state"><i class="dot" aria-hidden="true"></i><span class="state-t" data-state-for="${m.id}">Not loaded</span></span></span>
  <span class="tile-copy" id="cardBenefit-${m.id}">${c.benefit}</span>
  <span class="tile-langs">${c.langs.map(([l, n]) => `<em lang="${l === 'zh' ? 'zh-TW' : 'en'}">${n}</em>`).join('')}</span>
  <span class="tile-plus">${c.plus}</span><span class="tile-minus">${c.minus}</span></span></label>
  <button type="button" class="learn" data-learn="${m.id}" aria-label="Learn more about ${tileName(m)}">Learn more</button></div>`; };
$('models').innerHTML = TILES.map(RESEARCH_PAGE ? researchTile : publicCard).join('');
document.querySelectorAll('input[name=model]').forEach((r) => r.onchange = () => { selectModel.byUser = true; selectModel(r.value); selectModel.byUser = false; });

// ---- generation settings (per model) --------------------------------------------------------------------------------
// Each model keeps its own settings for the whole session (state.params[modelId], raw control values), so a value set for one model can never
// reach another, and Create, Compare and My Creations read the same store. The controls in Advanced show the selected model only.
state.params = {};
const rawParams = (m) => (state.params[m.id] ??= Object.fromEntries(m.params.map((p) => [p.id, String(p.def ?? '')])));
const parseParam = (p, v) => p.type === 'select' ? v : v === '' || v == null ? null : parseFloat(v);
function paramValues(m) { const raw = rawParams(m); return Object.fromEntries(m.params.map((p) => [p.id, parseParam(p, raw[p.id])])); }
function readParams(m, prefix = 'p_') {   // the selected model: read the visible controls (scripts may set .value directly), store them, return parsed values
  const raw = rawParams(m);
  for (const p of m.params) { const el = document.getElementById(prefix + p.id); if (el) raw[p.id] = el.value; }
  return paramValues(m);
}
function paramControls(m, prefix) {   // HTML for one model's controls; ids are prefix + parameter id
  const raw = rawParams(m), hint = (p) => !RESEARCH_PAGE && PARAM_HINT[m.id]?.[p.id] ? `<small class="p-hint">${PARAM_HINT[m.id][p.id]}</small>` : '';
  return m.params.map((p) => `<div class="param">${p.type === 'select'
    ? `<label>${p.label} <select id="${prefix}${p.id}" data-param="${p.id}">${p.options.map((o) => `<option${o === raw[p.id] ? ' selected' : ''}>${o}</option>`).join('')}</select></label>`
    : `<label>${p.label} <input type="number" id="${prefix}${p.id}" data-param="${p.id}" value="${raw[p.id]}" placeholder="${p.placeholder || ''}" min="${p.min}" max="${p.max}" step="${p.step}"></label>`}${p.presets ? `<span class="presets">${p.presets.map((s) => `<button type="button" class="sec preset" data-p="${p.id}" data-v="${s.value}">${s.label}</button>`).join('')}</span>` : ''}${hint(p)}</div>`).join('');
}
function bindParamControls(m, container, prefix) {
  const raw = rawParams(m);
  container.querySelectorAll('[data-param]').forEach((el) => el.addEventListener('input', () => { raw[el.dataset.param] = el.value; }));
  container.querySelectorAll('button.preset').forEach((b) => b.onclick = () => { const el = document.getElementById(prefix + b.dataset.p); el.value = b.dataset.v; raw[b.dataset.p] = b.dataset.v; });
}
function setParams(id, values) {   // used when a creation is reused: only that model's settings change
  const m = MODELS.find((x) => x.id === id); if (!m) return; const raw = rawParams(m);
  for (const p of m.params) if (values && values[p.id] !== undefined) raw[p.id] = values[p.id] == null ? '' : String(values[p.id]);
  if (state.tile === m) { $('params').innerHTML = paramControls(m, 'p_'); bindParamControls(m, $('params'), 'p_'); }
}

function selectModel(id) {
  const m = MODELS.find((x) => x.id === id);
  if (state.paramsShownFor && state.paramsShownFor !== m) readParams(state.paramsShownFor);   // keep what was typed for the previous model
  state.model = m; state.loaded = state.resident.has(m) ? m : null;   // other loaded models stay resident (see residency policy)
  state.tile = m; showError('');
  const radio = document.querySelector(`input[value=${id}]`); if (radio) radio.checked = true;
  $('modelMeta').textContent = `${m.backend} · languages: ${m.languages.join(', ')} · download ${m.size}. ${m.note || ''}`;
  $('refHint').textContent = m.refHint;
  $('status').textContent = m.status; $('paramNote').textContent = m.paramNote || '';
  $('backendRow').classList.toggle('hide', !m.fallback);   // the backend choice only exists for ZipVoice (hybrid tile); other models show just their own parameters
  $('refTextRow').classList.toggle('hide', !m.needsRefText);
  $('useDefault').classList.toggle('hide', !m.defaultVoice || !RESEARCH);
  $('params').innerHTML = paramControls(m, 'p_'); bindParamControls(m, $('params'), 'p_'); state.paramsShownFor = m;
  $('paramsFor').textContent = tileName(m);
  renderLoadStatus(); $('load').disabled = state.loaded === m;
  checkLang(); updateGate(); emit('model', {id: m.id, name: tileName(m), backend: m.backend, user: !!selectModel.byUser});
}

// Known-issue wording: the research page shows the full technical note, the public page the short honest label (full text stays in the adapter/docs).
const issueText = (k) => (RESEARCH_PAGE ? k.text : k.short || k.text);
function checkLang() {
  const m = state.model, t = $('text').value; if (!m) return;
  if (!RESEARCH_PAGE && !t.trim()) { $('langWarn').textContent = ''; return; }
  const zh = hasCJK(t), en = hasLatin(t);
  const need = zh && en ? 'zh+en' : zh ? 'zh' : 'en';
  const warns = [];
  const LN = {en: 'English', zh: 'Mandarin', 'zh+en': 'mixed Mandarin and English'};
  if (!m.languages.includes(need)) warns.push(RESEARCH_PAGE ? `${m.name} supports ${m.languages.join(', ')}; this text looks like "${need}" and will probably be unintelligible.` : `${tileName(m)} only speaks ${m.languages.map((l) => LN[l]).join(' and ')}; this looks like ${LN[need]} and will probably not sound right.`);
  for (const k of m.knownIssues) if (need === k.lang || (k.lang === 'en' && need === 'zh+en')) warns.push((k.level === 'pending' ? '⏳ ' : '⚠ ') + issueText(k));
  $('langWarn').textContent = warns.join('\n');
}
$('text').oninput = checkLang;

// ---- loading (lazy) -------------------------------------------------------------------------------------------------
// ---- model residency ------------------------------------------------------------------------------------------------------
// Measured on this Mac (phys. footprint incl. GPU, docs/chatterbox_lifecycle.md): idle page 0.5 GB; resident Chatterbox +2.0, Hybrid ZipVoice +2.7,
// F5 +2.9 GB (all three 8.2 GB); terminating a model's worker frees it. Initialising Chatterbox costs ~38 s, the others ~1-2 s once cached.
// Policy: keep at most MAX_RESIDENT models loaded (default 2; 1 on devices reporting < 8 GB; ?resident=N overrides). When over budget, evict the model that is
// cheapest to reload (measured load time), so the expensive Chatterbox is the last to go. Switching tiles therefore no longer throws a loaded model away.
const MAX_RESIDENT = q.get('resident') ? Math.max(1, parseInt(q.get('resident'), 10) || 1) : (navigator.deviceMemory && navigator.deviceMemory < 8 ? 1 : 2);
state.resident = new Set(); state.loading = new Map(); state.touched = new Map(); state.maxResident = MAX_RESIDENT;
const reloadCost = (m) => state.loadInfo[m.id]?.wallMs ?? 0;
function unloadModel(m, why) { lc(why, m.id); state.lifecycle.unloads++; m.unload(); state.resident.delete(m); state.touched.delete(m); if (state.loaded === m) state.loaded = null; log(why, m.id); }
function evictOverBudget(keep) {
  while (state.resident.size > MAX_RESIDENT) {
    const cand = [...state.resident].filter((x) => x !== keep && !state.loading.has(x)); if (!cand.length) break;
    cand.sort((a, b) => reloadCost(a) - reloadCost(b) || (state.touched.get(a) || 0) - (state.touched.get(b) || 0));
    unloadModel(cand[0], 'evict');
  }
}
function renderLoadStatus() {
  const m = state.model; if (!m) return; const el = $('loadStatus'); queueMicrotask(() => emit('load', {id: m.id, resident: state.resident.has(m), loading: state.loading.has(m)}));
  if (state.resident.has(m)) el.textContent = `Ready (loaded in ${fmtS(state.loadInfo[m.id]?.wallMs ?? 0)}, stays loaded)`;
  else if (state.loading.has(m)) el.textContent = state.loadText || 'Preparing the model…';
  else el.textContent = state.loadInfo[m.id] ? `Not loaded (it took ${fmtS(state.loadInfo[m.id].wallMs)} last time) — loads when needed` : 'Not loaded yet — loads when needed';
}
// Loading stage for the user-facing status, from the adapters' progress messages: model files arriving (byte counts are real: the adapters count the
// received bytes; a total is shown only where it is the total of the whole model and known in advance, i.e. the single-file WASM ZipVoice) or the runtime being started.
state.loadStage = new Map(); state.savedAtLoad = new Map(); state.loadBytes = new Map();
function loadStage(m, text = '') {
  const n = /(\d+) \/ (\d+) MB/.exec(text) || /(?:Downloading|weights) (\d+) MB/.exec(text);
  if (n && /Downloading|weights/.test(text)) return {kind: 'files', got: +n[1], total: n[2] && m.id === 'zipvoice' ? +n[2] : null};
  if (/Compiling|Initializing|ready|Runtime|standard runtime/i.test(text)) return {kind: 'start'};
  return null;
}
async function ensureLoaded(m = state.model) {
  if (state.resident.has(m)) { state.touched.set(m, performance.now()); if (m === state.model) state.loaded = m; return; }
  if (state.loading.has(m)) return state.loading.get(m);   // a background preload is already running: wait for it, never start a second load
  const p = (async () => {
    if (m === state.model) { $('load').disabled = true; setBar($('loadBar'), 0); }
    const t0 = performance.now(); lc('load:start', m.id); state.lifecycle.loads[m.id] = (state.lifecycle.loads[m.id] || 0) + 1;
    state.savedAtLoad.set(m.id, !!window.vsStore?.saved(m.id));   // were this model's files already on the device when this load began? (deployed release)
    try {
      const info = await m.load({onDiag: (d) => { if (d.stage === 'model:ok') state.lifecycle.sessions++; lc('diag:' + d.stage, m.id + (d.file ? ' ' + d.file.split('/').pop() : '')); },
        onProgress: ({text, fraction}) => { const st = loadStage(m, text);
          if (st?.kind === 'files') {   // ZipVoice and F5 count per file: add up finished files so the number shown only ever grows
            const b = state.loadBytes.get(m.id) || {base: 0, cur: 0}; if (st.got < b.cur) b.base += b.cur; b.cur = st.got; state.loadBytes.set(m.id, b); st.got = b.base + b.cur;
          }
          if (st) state.loadStage.set(m.id, st);
          if (m === state.model) { if (text) { state.loadText = text; renderLoadStatus(); } if (fraction != null) setBar($('loadBar'), fraction); } }});
      state.loadInfo[m.id] = {...info, wallMs: performance.now() - t0}; state.resident.add(m); state.touched.set(m, performance.now());
      if (m === state.model) state.loaded = m;
      lc('load:end', `${m.id} ${Math.round(performance.now() - t0)} ms`); log('loaded', m.id, JSON.stringify(state.loadInfo[m.id]));
      evictOverBudget(m);
    } catch (e) {
      lc('load:fail', m.id); m.unload(); state.resident.delete(m); if (state.loaded === m) state.loaded = null; throw e;
    } finally { state.loading.delete(m); state.loadText = ''; state.loadStage.delete(m.id); state.loadBytes.delete(m.id); if (m === state.model) { setBar($('loadBar'), null); $('load').disabled = state.resident.has(m); } renderLoadStatus(); }
  })();
  state.loading.set(m, p); renderLoadStatus(); return p;
}
// Background preload (public page): as soon as the user confirms a model whose files are all local (no network), the UI calls pg.preload() and
// initialisation runs while they type and record, so the first Generate does not pay the full load. Merely browsing the cards (or the default
// selection at page load) does not load anything. ?preload=0 disables it.
let preloadTimer = null;
function schedulePreload(delay = 1500) {
  clearTimeout(preloadTimer); if (RESEARCH_PAGE || q.get('preload') === '0') return;
  const m = state.model;
  preloadTimer = setTimeout(async () => {
    await state.assetsReady; const g = state.assets && state.assets.byModel[m.id];
    if (state.model !== m || state.busy || !g || !g.ok || state.resident.has(m) || state.loading.has(m)) return;
    lc('preload', m.id); ensureLoaded(m).catch((e) => log('preload failed', m.id, String(e.message || e)));
  }, delay);
}
$('load').onclick = () => ensureLoaded().catch(showError);

// ---- reference ------------------------------------------------------------------------------------------------------
function setRef(ref, name, blobUrl) {
  state.ref = ref; state.refName = name;
  $('refAudio').src = blobUrl; $('refAudio').classList.remove('hide'); $('refInfo').classList.remove('hide');
  $('refInfo').textContent = `${name} · ${(ref.samples.length / ref.sampleRate).toFixed(1)} s @ ${ref.sampleRate} Hz`;
  updateGate();
}
if (RESEARCH) $('refFile').onchange = async () => {
  const f = $('refFile').files[0]; if (!f) return;
  try { setRef(await decodeAudio(await f.arrayBuffer()), f.name, URL.createObjectURL(f)); showError('');
    // a stale passage transcript would not match an uploaded file
    if (PASSAGES.some((p) => p.text === $('refText').value)) $('refText').value = '';
    state.recording = null; setRecUi(false); $('recStatus').textContent = ''; $('recWarn').textContent = '';
  } catch (e) { showError('Could not decode reference audio: ' + e.message); }
};
if (RESEARCH) $('useDefault').onclick = async () => {
  try { const buf = await state.model.defaultVoice(); setRef(await decodeAudio(buf.slice(0)), "model's default voice", URL.createObjectURL(new Blob([buf], {type: 'audio/wav'}))); showError(''); }
  catch (e) { showError('Could not fetch default voice: ' + e.message); }
};

// ---- generate gate: the public page needs a valid microphone recording (and, where the model needs it, a transcript) ------
function updateGate() {
  if (RESEARCH) return;
  const m = state.model; let need = '';
  if (!state.ref) need = 'Record your voice first.';
  else if (m && m.needsRefText && !$('refText').value.trim()) need = 'The recording needs a transcript: open “I read something different” and type what you said.';
  $('genNeed').textContent = need; $('genNeed').classList.toggle('hide', !need);
  $('generate').disabled = state.busy || !!need;
}
$('refText').addEventListener('input', updateGate);

// ---- guided recording -----------------------------------------------------------------------------------------------
// Passage text becomes the reference transcript automatically; the transcript box stays editable (manual correction wins).
let rec = null, recUrl = null;
let passageIdx = {en: 0, zh: 0};
const passage = () => RESEARCH ? PASSAGES.find((p) => p.id === $('passageSel').value)
  : PASSAGES.filter((p) => p.lang === $('recLang').value)[passageIdx[$('recLang').value] % PASSAGES.filter((p) => p.lang === $('recLang').value).length];
if (RESEARCH) $('passageSel').innerHTML = PASSAGES.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
function showPassage() { const p = passage(); $('passageText').textContent = p.text; $('passageText').lang = p.lang === 'zh' ? 'zh-TW' : 'en'; }
$('passageSel').onchange = showPassage; $('recLang').onchange = showPassage;
$('newScript').onclick = () => { const l = $('recLang').value; passageIdx[l]++; showPassage(); };
showPassage();
const lockPassage = (on) => { for (const id of ['passageSel', 'recLang', 'newScript']) $(id).disabled = on; };
const setRecUi = (has) => { for (const id of ['recPlay', 'recAgain', 'recClear']) $(id).classList.toggle('hide', !has); };
async function stopRecording() {
  if (!rec) return;
  const r = rec; rec = null; $('recStop').disabled = true;
  const pcm = await r.stop(), a = assess(pcm);
  if (!a.valid) {   // too short / silent: never becomes the reference
    $('recStatus').textContent = ''; $('recWarn').textContent = a.warns.join(' ') + ' Please record again.'; $('recStart').disabled = false; setBar($('recLevel'), null); lockPassage(false);
    state.recording = null; emit('recinvalid'); return;
  }
  if (recUrl) URL.revokeObjectURL(recUrl);
  const wav = wavBlob(pcm.samples, pcm.sampleRate); recUrl = URL.createObjectURL(wav);
  setRef(pcm, `recording (${passage().label})`, recUrl);
  $('refText').value = passage().text;            // editable; user may correct what they actually said
  updateGate();
  $('recStatus').textContent = `Recorded ${a.sec.toFixed(1)} s. Play it back if you like.`;
  $('recWarn').textContent = a.warns.join(' '); $('recStart').disabled = false; setRecUi(true); setBar($('recLevel'), null); lockPassage(false);
  // diagnostics: round-trip the WAV through the same decoder Upload Audio uses
  let dec = null; try { dec = await decodeAudio(await wav.arrayBuffer()); } catch (e) { dec = {error: e.message}; }
  const rows = [['Duration', a.sec.toFixed(2) + ' s'], ['Capture sample rate', pcm.sampleRate + ' Hz, mono, Float32 PCM'], ['Peak / RMS', `${a.peak.toFixed(3)} / ${a.rmsDb.toFixed(1)} dBFS`],
    ['Decode check (WAV → decodeAudioData)', dec.error ? 'FAILED: ' + dec.error : `${dec.samples.length} samples @ ${dec.sampleRate} Hz — ${dec.samples.length === pcm.samples.length ? 'matches' : 'length differs'}`],
    ['Transcript source', 'passage text (editable)'], ['Model handling', 'Chatterbox and F5 resample the reference to 24 kHz in the page; ZipVoice receives the native rate and sherpa-onnx resamples it']];
  $('recDiag').tBodies[0].innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  state.recording = {sec: a.sec, sampleRate: pcm.sampleRate, peak: a.peak, rmsDb: a.rmsDb, decodeOk: !dec.error && dec.samples.length === pcm.samples.length};
  log('recorded', JSON.stringify(state.recording)); emit('recorded', {sec: a.sec});
}
async function startRecording() {
  showError(''); $('recWarn').textContent = '';
  try {
    rec = new Recorder({onLevel: ({level, seconds}) => { setBar($('recLevel'), Math.min(1, level)); emit('level', {level, seconds}); $('recStatus').textContent = `Recording… ${seconds.toFixed(1)} s — read the passage aloud`; if (seconds >= MAX_SECONDS) stopRecording(); }});
    await rec.start();
  } catch (e) { rec = null; $('recStatus').textContent = ''; return showError(e); }
  $('recStart').disabled = true; $('recStop').disabled = false; lockPassage(true); setRecUi(false); $('recStatus').textContent = 'Recording…'; setBar($('recLevel'), 0); emit('recstart');
  // Watchdog: if the audio graph stops delivering samples (seen when the OS audio device is not clocking), stop instead of "recording" forever.
  const r = rec; let lastSec = -1, since = performance.now();
  const watch = setInterval(() => {
    if (rec !== r) return clearInterval(watch);
    const sec = r.seconds(); if (sec > lastSec + 0.05) { lastSec = sec; since = performance.now(); return; }
    if (performance.now() - since < 3000) return;
    clearInterval(watch); r.cancel(); rec = null; log('recording stalled', sec);
    $('recStart').disabled = false; $('recStop').disabled = true; lockPassage(false); setBar($('recLevel'), null); $('recStatus').textContent = '';
    showError('The browser stopped receiving audio from the microphone. Please try again; if it keeps happening, restart the browser.'); emit('recinvalid');
  }, 500);
}
function clearRecording() {
  state.ref = null; state.refName = null; state.recording = null; if (recUrl) { URL.revokeObjectURL(recUrl); recUrl = null; }
  $('refAudio').removeAttribute('src'); $('refAudio').classList.add('hide'); $('refInfo').textContent = '';
  $('refText').value = '';   // the transcript belongs to the recording
  $('recStatus').textContent = RESEARCH ? '' : 'Press the microphone when you are ready.'; $('refInfo').classList.add('hide'); $('recWarn').textContent = ''; setRecUi(false); updateGate(); emit('recclear'); $('recDiag').tBodies[0].innerHTML = '<tr><td>No recording yet</td><td></td></tr>';
}
$('recStart').onclick = startRecording;
$('recStop').onclick = () => stopRecording().catch(showError);
$('recPlay').onclick = () => { const a = $('refAudio'); if (a.paused) { if (a.ended) a.currentTime = 0; a.play(); } else a.pause(); };   // only ever runs from this button press
$('recAgain').onclick = () => { clearRecording(); startRecording(); };
$('recClear').onclick = clearRecording;
window.addEventListener('pagehide', () => rec && rec.cancel());

// ---- asset preflight (startup) ---------------------------------------------------------------------------------------
// Which local files each tile needs. Missing optional/own assets never break a model silently: the reason is shown and the workers fall back
// (hybrid -> WASM baseline; Chatterbox/F5 -> CDN / Hugging Face when online).
const REMEDY = 'node playground/tools/check_assets.mjs  (fix: playground/tools/provision_assets.sh, docs/demo_assets.md)';
function renderAssets(a, err) {
  const rows = err ? [['Asset manifest', 'ERROR: ' + err]] : a.groups.map((g) => [`${g.model} — ${g.label}`,
    g.ok ? `ready · ${g.files} files · ${(g.bytes / 1e6).toFixed(0)} MB present` : `INCOMPLETE (${g.missing.length}/${g.files}): ${g.missing.slice(0, 3).map((m) => m.path.split('/').pop() + ' ' + m.why).join('; ')}${g.missing.length > 3 ? '…' : ''}`]);
  if ($('assetTable').tBodies) $('assetTable').tBodies[0].innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  const msgs = [];
  if (PRODUCTION) { prodAssets(a, err); return; }
  if (!err) {
    const b = a.byModel;
    if (!b.zipvoice.ok) msgs.push('⚠ ZipVoice (WASM) files are missing or incomplete, so ZipVoice cannot run. ' + REMEDY);
    else if (!b['zipvoice-hybrid'].ok) msgs.push('⚠ ZipVoice will use the slower WASM CPU backend: the WebGPU files are missing or incomplete. ' + REMEDY);
    for (const id of ['chatterbox', 'f5']) if (!b[id].ok) msgs.push(`ℹ ${id === 'f5' ? 'F5-TTS' : 'Chatterbox'}: local files incomplete, so it needs an internet connection (first use downloads them). ${REMEDY}`);
  } else msgs.push('⚠ Asset preflight could not run: ' + err);
  $('assetBanner').textContent = msgs.join('\n'); $('assetBanner').classList.toggle('hide', !msgs.length);
  log('assets', JSON.stringify(err ? {err} : Object.fromEntries(a.groups.map((g) => [g.model, g.ok ? 'ready' : g.missing.length + ' missing']))));
}
// A deployed release (deploy/build_release.mjs adds <meta name="vs-release">): the same check, in words for visitors. A model whose files are missing
// from the site, or not saved on this device while offline, is marked unavailable (studio/device.js shows why on its card and in Compare).
function prodAssets(a, err) {
  // Files a model does not need on this device do not count: the unused Chatterbox language-model variant (q4 is the CPU one, q4f16 the GPU one), the
  // stock-runtime rollback files, and the default voice (research page only). Offline, a visitor only has the files their own device used.
  const optional = (p) => /default_voice\.wav$/.test(p) || (navigator.gpu ? /language_model_q4\.onnx/ : /language_model_q4f16\.onnx/).test(p) || /onnxruntime-web@1\.25\.0-dev[^/]*\/dist\//.test(p);
  if (a) a = {...a, byModel: Object.fromEntries(a.groups.map((g) => { const missing = g.missing.filter((x) => !optional(x.path)); return [g.model, {...g, missing, ok: !missing.length}]; }))};
  if (a) a.groups = Object.values(a.byModel);
  const ua = state.assetUnavailable = {}, msgs = [], b = a?.byModel, offline = (g) => g.missing.length && g.missing.every((x) => x.why === 'unreachable');
  if (err) msgs.push(navigator.onLine ? 'This website could not check its model files. Some models may not load.' : 'You are offline. Only models already saved on this device can be used.');
  else {
    const why = (g) => offline(g) ? 'It is not saved on this device and the website cannot be reached right now.' : `Some of its files are missing from this website (${g.missing[0].path.split('/').pop()}).`;
    // ZipVoice works if either path is complete: the GPU path (hybrid group, needs WebGPU) or the CPU path (baseline group). Offline, a visitor who only
    // ever used the GPU path has only that one saved, and that is enough.
    const zv = b.zipvoice.ok, hy = b['zipvoice-hybrid'].ok && !!navigator.gpu;
    if (!zv && !hy) ua['zipvoice-hybrid'] = why(navigator.gpu ? b['zipvoice-hybrid'] : b.zipvoice);
    else if (!hy && navigator.gpu) msgs.push('ZipVoice will run on the processor (slower): its graphics-processor files are unavailable right now.');
    for (const id of ['chatterbox', 'f5']) if (!b[id].ok) ua[id] = why(b[id]);
    const n = Object.keys(ua).length, names = Object.keys(ua).map((id) => tileName(MODELS.find((m) => m.id === id)));
    if (n && a.groups.some(offline)) msgs.push(`You are offline. ${names.join(' and ')} ${n > 1 ? 'are' : 'is'} not saved on this device; models you used before still work.`);
    else if (n) msgs.push(`${names.join(' and ')} cannot be used right now: some files are missing from this website. Please let the site owner know.`);
  }
  $('assetBanner').textContent = msgs.join('\n'); $('assetBanner').classList.toggle('hide', !msgs.length);
  log('assets', JSON.stringify(err ? {err} : Object.fromEntries(a.groups.map((g) => [g.model, g.ok ? 'ready' : g.missing.length + ' missing']))));
  emit('assets', {unavailable: ua});
}
state.assetsReady = checkAssets().then((a) => { state.assets = a; renderAssets(a); return a; }).catch((e) => { state.assets = null; renderAssets(null, String(e.message || e)); return null; });

// ---- backend routing / reporting -----------------------------------------------------------------------------------
function useModel(m) { state.model = m; state.loaded = state.resident.has(m) ? m : null; }
function routeModel(tile) { // "WASM only" (Advanced) runs the plain baseline adapter instead of the hybrid one
  return !RESEARCH_PAGE && tile.fallback && $('backendSel').value === 'wasm' ? MODELS.find((x) => x.id === tile.fallback) : tile;
}
function backendUsed(m, r) { // what actually executed, from the adapter's own result, not from what was requested
  if (m.id === 'zipvoice-hybrid') return r.detail.backend === 'webgpu' ? 'WebGPU decoder (FP32) + WASM front end/vocoder' : 'WASM CPU (INT8, patched runtime)';
  if (m.id === 'zipvoice') return 'WASM CPU (INT8, 1 thread)';
  if (m.id === 'chatterbox' && r.detail?.device === 'wasm') return `WASM CPU · Transformers.js / ORT-web (${state.loadInfo.chatterbox?.dtype?.language_model || 'q4'} LM)`;   // no WebGPU: the worker chose its CPU device and the q4 language model
  if (m.id === 'f5' && state.loadInfo.f5?.device === 'wasm') return 'WASM CPU · ORT-web (fp32 transformer)';         // same for F5 (its worker reports the device at load)
  return m.backend;
}
const lifecycleRows = () => [['Workers created / terminated', `${state.lifecycle.workersCreated} / ${state.lifecycle.workersTerminated}`], ['Model loads (per model)', JSON.stringify(state.lifecycle.loads)], ['Unloads', state.lifecycle.unloads], ['Generate calls', state.lifecycle.generates], ['Chatterbox model sessions created', state.lifecycle.sessions], ['Resident now', [...state.resident].map((x) => x.id).join(', ') || 'none'], ['Timeline', state.lifecycle.events.slice(-14).map((e) => `${(e.t / 1000).toFixed(1)}s ${e.ev}${e.detail ? ' ' + e.detail : ''}`).join('<br>')]];
function renderLifecycle() { if ($('lifecycleTable').tBodies) $('lifecycleTable').tBodies[0].innerHTML = lifecycleRows().map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join(''); }

// ---- generation pipeline (shared by Create, Compare and My Creations) ----------------------------------------------------
// One generation = route the tile to an adapter (ZipVoice "WASM only" setting), wait for/perform its load through ensureLoaded (so background preloads,
// residency and eviction apply to every caller), run the adapter, and on a ZipVoice WebGPU failure fall back to the WASM baseline with a notice.
// Everything reported (backend, timings, load context) comes from the adapter's own result and from timestamps taken here. Callers own their UI.
// `select`: Create's own generation also makes the model the page's current model (as before); Compare and My Creations leave Create's selection alone.
async function runGeneration({tile, text, ref, refText, refName = state.refName, params, onProgress = () => {}, onNotice = () => {}, select = false, source = 'create', extra = {}}) {
  let m = routeModel(tile), via = m, r, loadThisClickMs = 0, wasResident = false, wasLoading = false;
  const refDur = ref.samples.length / ref.sampleRate, click = performance.now(), adopt = (x) => { if (select) useModel(x); };
  try {
    try {
      await state.assetsReady;
      if (m.fallback && state.assets && !state.assets.byModel[m.id]?.ok) throw new Error(`required local files are missing (${state.assets.byModel[m.id].missing.slice(0, 2).map((x) => x.path.split('/').pop()).join(', ')}…)`);
      adopt(m); wasResident = state.resident.has(m); wasLoading = state.loading.has(m); const tl = performance.now(); await ensureLoaded(m); loadThisClickMs = wasResident ? 0 : performance.now() - tl;
      onProgress({text: 'Generating…'}); lc('generate:start', m.id); state.lifecycle.generates++;
      r = await m.generate({text, ref, refText, params, onProgress});
    } catch (err) {
      const fb = m.fallback && MODELS.find((x) => x.id === m.fallback);
      if (!fb) throw err;
      // Automatic fallback to the WASM baseline; the notice stays on screen so the switch is never silent.
      onNotice(`${tileName(m)} could not use WebGPU (${String(err.message || err).split('\n')[0].slice(0, 200)}) — generated with the WASM CPU baseline instead.`);
      unloadModel(m, 'fallback-unload');
      m = via = fb; adopt(fb); wasResident = state.resident.has(fb); wasLoading = state.loading.has(fb);
      const fbParams = Object.fromEntries(fb.params.map((p) => [p.id, params[p.id] ?? p.def]));
      const tl2 = performance.now(); await ensureLoaded(fb); loadThisClickMs = wasResident ? 0 : performance.now() - tl2; onProgress({text: 'Generating…'}); lc('generate:start', m.id); state.lifecycle.generates++;
      r = await m.generate({text, ref, refText, params: fbParams, onProgress});
    }
  } catch (e) {
    // A failed generation may leave a dead worker behind: release that model so the next try re-initialises it.
    if (state.resident.has(m) && !state.loading.has(m)) { unloadModel(m, 'unload-after-error'); e.released = true; }
    renderLifecycle(); throw e;
  }
  const dur = r.samples.length / r.sampleRate, e2e = performance.now() - click;
  const run = {model: m.id, requestedModel: tile.id, source, text, refName, refSeconds: refDur, refText: m.needsRefText ? refText : null, params,
    genMs: r.genMs, audioSec: dur, rtf: r.genMs / 1000 / dur, clickToResultMs: e2e, loadMs: state.loadInfo[m.id]?.loadMs ?? null, loadThisClickMs, modelReused: wasResident, preloadedInBackground: wasLoading, detail: r.detail,
    sampleRate: r.sampleRate, peak: r.samples.reduce((a, s) => Math.max(a, Math.abs(s)), 0), ts: Date.now()};
  lc('generate:end', `${m.id} infer ${Math.round(r.genMs)} ms`); run.lifecycle = JSON.parse(JSON.stringify({...state.lifecycle, events: undefined}));
  run.backendUsed = backendUsed(m, r); run.e2eRtf = e2e / 1000 / dur; run.fellBack = m !== routeModel(tile);
  renderLifecycle(); renderMetrics(run, tile);
  const blob = wavBlob(r.samples, r.sampleRate);
  log('generated', JSON.stringify({source, model: m.id, backend: run.backendUsed, genMs: r.genMs, dur, rtf: run.rtf}));
  document.dispatchEvent(new CustomEvent('pg:result', {detail: {run, blob, samples: r.samples, extra}}));   // My Creations stores it (studio/history.js)
  return {run, samples: r.samples, sampleRate: r.sampleRate, blob, model: m};
}
const loadContext = (run) => run.modelReused ? `already loaded (initial load ${run.loadMs == null ? '—' : fmtS(run.loadMs)}, not repeated)` : `waited ${fmtS(run.loadThisClickMs)} for the model${run.preloadedInBackground ? ' (it was already loading in the background; total initial load ' + fmtS(run.loadMs ?? 0) + ')' : ' (this click)'}`;
function renderMetrics(run, tile) {   // Developer diagnostics → Last generation (any source)
  const d = run.detail || {};
  $('metrics').tBodies[0].innerHTML = [
    ['Model', tileName(tile)], ['Started from', {create: 'Create', compare: 'Compare', library: 'My Creations'}[run.source] || run.source], ['Backend actually used', run.backendUsed], ...(d.ortRuntime ? [['ONNX Runtime (Chatterbox)', d.ortRuntime === 'patched' ? 'patched fast-load build (memory-reuse planning off for conditional_decoder)' : d.ortRuntime]] : []), ['Reference', `${run.refName} (${run.refSeconds.toFixed(1)} s)`],
    ['Parameters', JSON.stringify({...run.params, ...d.resolved})], ...(d.odeEndT !== undefined ? [['ODE end time (must be 1.000)', d.odeEndT.toFixed(3) + ` after ${d.eulerSteps} Euler steps`]] : []),
    ['Model load', loadContext(run)], ['Inference time', fmtS(run.genMs)],
    ['Generated audio', run.audioSec.toFixed(2) + ' s'], ['RTF (inference ÷ audio)', run.rtf.toFixed(2)], ['Click → result', fmtS(run.clickToResultMs)], ['End-to-end RTF (click → result ÷ audio)', run.e2eRtf.toFixed(2)],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  $('resultSummary').textContent = `${run.audioSec.toFixed(1)} s of speech generated in ${fmtS(run.genMs)} · ${run.backendUsed}.`;
  $('resultBackend').textContent = 'Backend used: ' + run.backendUsed;
}
// One generation at a time on this page (all models share the GPU): Create, Compare and My Creations go through this lock.
async function exclusive(fn) {
  if (state.busy) throw new Error('Another generation is still running. Please wait for it to finish.');
  state.busy = true; updateGate(); document.dispatchEvent(new CustomEvent('pg:busy', {detail: true}));
  try { return await fn(); } finally { state.busy = false; updateGate(); document.dispatchEvent(new CustomEvent('pg:busy', {detail: false})); }
}

// ---- Create: Generate ------------------------------------------------------------------------------------------------
// The public page shows ONE primary status for generation: the Generate button ("Preparing the model…" / "Generating…", see ux/ux.js). The line under
// it only carries stage information the runtime actually reports (Chatterbox "Encoding reference voice…", F5 "Preparing your voice…" →
// "Generating your voice — Step N of M" → "Finishing the audio…"); a generic "Generating…" or a chunk percentage would only repeat the button.
const stageText = (t) => !RESEARCH_PAGE && /^Generating…/.test(t) ? '' : t;
$('generate').onclick = async () => {
  if (state.busy) return;
  const tile = state.tile; showError(''); $('notice').textContent = '';
  if (!tile) return showError('Choose a model first.');
  const m0 = routeModel(tile);
  const text = $('text').value.trim(), refText = $('refText').value.trim();
  if (!state.ref) return showError(RESEARCH ? 'Choose a reference audio file' + (m0.defaultVoice ? ' or use the default voice.' : '.') : 'Record your voice first. No default voice is used.');
  if (m0.needsRefText && !refText) return showError('This model needs the exact transcript of the reference audio.');
  if (!text) return showError('Enter some text.');
  const refDur = state.ref.samples.length / state.ref.sampleRate;
  if (refDur > 30) return showError(`The recording is ${refDur.toFixed(0)} s; please record again (about 5–15 s).`);
  const params = readParams(tile);
  $('genStatus').textContent = ''; setBar($('genBar'), 0); emit('generating');
  try {
    const progress = ({text: t, fraction}) => { if (t) $('genStatus').textContent = stageText(t); if (fraction != null) setBar($('genBar'), fraction); };
    const {run, samples, blob, model: m} = await exclusive(() => runGeneration({tile, text, ref: state.ref, refText, params, onProgress: progress, onNotice: showNotice, select: true, source: 'create'}));
    const url = URL.createObjectURL(blob);
    if ($('out').src.startsWith('blob:')) URL.revokeObjectURL($('out').src);   // the previous result stays in My Creations under its own URL
    $('out').src = url; $('download').href = url; $('resultSec').classList.remove('hide');
    if (q.get('mute') === '1') $('out').muted = true;       // belt and braces for automated runs
    window.lastRun = run; window.lastSamples = samples;
    $('genStatus').textContent = 'Done — press play to listen.';
    const need = hasCJK(text) ? (hasLatin(text) ? 'zh+en' : 'zh') : 'en';
    $('resultIssue').textContent = m.knownIssues.filter((k) => need === k.lang || (k.lang === 'en' && need === 'zh+en')).map((k) => (k.level === 'pending' ? '⏳ ' : '⚠ ') + issueText(k)).join(' ');
    $('resultIssue').className = m.knownIssues.some((k) => k.level !== 'pending') ? 'err' : 'warn';
    emit('generated', {sec: run.audioSec, backend: run.backendUsed});
  } catch (e) {
    showError(e); $('genStatus').textContent = 'Failed'; emit('genfailed');
    if (e.released) showError(String(e.message || e) + '\n(The model was released and will be re-initialised on the next try.)');
  }
  finally { setBar($('genBar'), null); }
};

// Shared with the studio views (studio/*.js). They never reach into adapters directly.
Object.assign(window.pg, {
  run: (o) => exclusive(() => runGeneration(o)), tiles: TILES, tileName, routeModel, paramValues, readParams, paramControls, bindParamControls, setParams, ensureLoaded,
  get busy() { return state.busy; }, info: INFO,
});

selectModel(q.get('model') && MODELS.some((m) => m.id === q.get('model')) ? q.get('model') : MODELS[0].id);

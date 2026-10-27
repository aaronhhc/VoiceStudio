// My creations: replay, download, reuse, generate again, send to Compare, delete — for every result of this session (and, if the listener opted in,
// earlier sessions stored on this device). The audio is the stored WAV; nothing is regenerated to replay it.
import * as player from './player.js';
import * as store from './history.js';
import {ranOn, settingsText} from './models-info.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const LANG = {en: 'English', zh: 'Mandarin', mixed: 'Mandarin + English', unknown: '—'};
const SRC = {create: 'Create', compare: 'Compare', library: 'Generated again'};
const mb = (b) => (b / 1e6).toFixed(b < 1e7 ? 1 : 0) + ' MB';
const when = (ts) => { const d = new Date(ts), today = new Date().toDateString() === d.toDateString();
  return (today ? 'Today' : d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'})) + ', ' + d.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'}); };
let root = null, mounted = [];

function render() {
  if (!root) return;
  mounted.forEach((k) => player.unmount(k)); mounted = [];
  const items = store.list(), info = store.info();
  root.querySelector('#libList').innerHTML = items.length ? items.map(item).join('') : `<div class="empty"><p>Nothing here yet.</p><p class="fine">Everything you generate — in Create or Compare — appears here so you can listen again without generating it again.</p><button type="button" class="pill-btn" data-view-link="create">Create something</button></div>`;
  for (const e of items) { const slot = root.querySelector(`[data-entry="${e.id}"] .lib-player`); player.mount(slot, {key: 'lib:' + e.id, label: `${e.modelName}: ${e.text.slice(0, 40)}`, pk: e.peaks, sec: e.audioSec, getUrl: () => store.url(e)}); mounted.push('lib:' + e.id); }
  root.querySelector('#libMeta').textContent = items.length ? `${items.length} creation${items.length > 1 ? 's' : ''} · ${mb(info.bytes)} of audio${info.dropped ? ` · ${info.dropped} older one${info.dropped > 1 ? 's were' : ' was'} released to stay within the limit` : ''}` : '';
  root.querySelector('#libClear').hidden = !items.length && !info.persistent;
  root.querySelector('#libClear').textContent = info.persistent ? 'Delete all local history' : 'Clear this session';
  const keep = root.querySelector('#libKeep'); keep.checked = info.persistent;
  root.querySelector('#libStore').innerHTML = info.persistent ? `Stored on this device in this browser (not encrypted; anyone using this browser profile can open it). Turning this off deletes the stored copies.${info.lastError ? ` <span class="warn">${esc(info.lastError)}</span>` : ''}` :
    `Off: creations disappear when you close this tab.${info.lastError ? ` <span class="warn">${esc(info.lastError)}</span>` : ''}`;
  store.usage().then((u) => { const el = root.querySelector('#libQuota'); if (el) el.textContent = u && info.persistent ? `Browser storage used by this site: ${mb(u.usage)} of ${mb(u.quota)} available (includes the cached model files).` : ''; });
  const d = document.getElementById('libDiag'); if (d) d.textContent = `${info.count} entries, ${mb(info.bytes)} of WAV audio held in memory (limits: ${store.LIMITS.entries} entries / ${mb(store.LIMITS.bytes)}); stored on device: ${info.persistent ? 'yes' : 'no'}; released by the limit: ${info.dropped}.`;
  const c = document.getElementById('libCount'); if (c) { c.textContent = items.length ? String(items.length) : ''; c.setAttribute('aria-label', items.length ? `${items.length} creations` : ''); }
}
function item(e) {
  const p = settingsText(window.pg.models.find((m) => m.id === e.requestedModel), e.params);
  return `<article class="lib-item" data-entry="${e.id}" aria-label="${esc(e.modelName)}, ${when(e.ts)}">
    <div class="lib-top"><div class="lib-player"></div></div>
    <p class="lib-text" lang="${e.targetLang === 'zh' ? 'zh-TW' : e.targetLang === 'en' ? 'en' : ''}">${esc(e.text)}</p>
    <div class="lib-tags"><span>${esc(e.modelName)}${e.blindLabel ? ` <small>(blind Sample ${e.blindLabel})</small>` : ''}</span><span>${LANG[e.targetLang] || '—'}</span><span>${e.audioSec.toFixed(1)} s</span><span>${when(e.ts)}</span><span class="quiet">${SRC[e.source] || e.source}</span>${e.stored ? '<span class="quiet" title="A copy is stored on this device">On device</span>' : ''}</div>
    <details class="lib-details"><summary>Details</summary><dl class="metrics">
      <div><dt>Ran on</dt><dd title="${esc(e.backendUsed)}">${esc(ranOn(e.backendUsed))}${e.fellBack ? ' (automatic fallback)' : ''}</dd></div>
      <div><dt>Generation time</dt><dd>${(e.genMs / 1000).toFixed(2)} s</dd></div>
      <div><dt>RTF</dt><dd>${e.rtf.toFixed(2)}</dd></div>
      <div><dt>Click → audio</dt><dd>${(e.clickToResultMs / 1000).toFixed(2)} s (${e.modelReused ? 'model already loaded' : `incl. ${(e.loadThisClickMs / 1000).toFixed(1)} s model loading`})</dd></div>
      <div><dt>Settings</dt><dd>${esc(p) || 'defaults'}</dd></div>
      ${e.ortRuntime ? `<div><dt>Runtime</dt><dd>ONNX Runtime ${esc(e.ortRuntime === 'patched' ? 'fast-start build' : e.ortRuntime)}</dd></div>` : ''}
      <div><dt>Voice</dt><dd>Your recording, ${e.refSeconds.toFixed(1)} s${e.refLang ? `, ${LANG[e.refLang]} passage` : ''} (not stored)</dd></div>
      <div><dt>Audio</dt><dd>${e.sampleRate} Hz WAV, ${mb(e.bytes)}</dd></div></dl></details>
    <div class="lib-actions">
      <a class="text-btn" data-dl="${e.id}" href="#" download="${esc(e.modelName.replace(/\W+/g, '-').toLowerCase())}-${new Date(e.ts).toISOString().slice(0, 19).replace(/[:T]/g, '')}.wav">Download WAV</a>
      <button type="button" class="text-btn" data-act="reuse">Reuse text and settings</button>
      <button type="button" class="text-btn" data-act="again">Generate again</button>
      <button type="button" class="text-btn" data-act="compare">Compare</button>
      <button type="button" class="text-btn quiet" data-act="delete">Delete</button></div></article>`;
}
function act(e, what) {
  if (what === 'delete') { player.unmount('lib:' + e.id); store.remove(e.id); return; }
  if (what === 'compare') { window.studio.compare.prefill({text: e.text, models: [e.requestedModel]}); window.studio.show('compare'); return; }
  player.stop();
  const target = window.ux.reuse({model: e.requestedModel, text: e.text, params: e.params, generate: what === 'again'});
  if (what === 'again' && target !== 'ready' && target !== 'unavailable') window.studio.toast('Your recording is needed to generate again: record or confirm it, then press Generate.');
}

export function mount(el) {
  root = el;
  root.innerHTML = `<header class="view-head"><h1 id="libTitle" tabindex="-1">My creations</h1><p class="lede">Everything you generated, ready to play again. It stays on this computer.</p></header>
    <div class="lib-bar"><p class="fine" id="libMeta"></p>
      <label class="switch"><input type="checkbox" id="libKeep"> <span>Keep on this device</span><small id="libStore"></small></label><p class="fine" id="libQuota"></p>
      <button type="button" class="text-btn quiet" id="libClear">Clear this session</button></div>
    <div class="lib-list" id="libList"></div>
    <p class="fine lib-foot">Up to ${store.LIMITS.entries} creations or ${mb(store.LIMITS.bytes)} of audio are kept; the oldest are released first. Your voice recording is never stored here.</p>`;
  root.querySelector('#libKeep').addEventListener('change', async (ev) => {
    if (ev.target.checked) await store.enablePersistence();
    else if (confirm('Stop keeping creations on this device? The stored copies will be deleted. This session’s list stays until you close the tab.')) await store.disablePersistence();
    else ev.target.checked = true;
    render();
  });
  root.querySelector('#libClear').addEventListener('click', async () => {
    const info = store.info();
    if (!confirm(info.persistent ? 'Delete all creations, including the copies stored on this device?' : 'Clear all creations from this session?')) return;
    player.stop(); await store.clear(); render();
  });
  root.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-dl]'); if (a) { const e = store.get(a.dataset.dl); if (e) a.href = store.url(e); return; }
    const b = ev.target.closest('[data-act]'); if (!b) return; const e = store.get(b.closest('[data-entry]').dataset.entry); if (e) act(e, b.dataset.act);
  });
  store.subscribe(render); render();
}
export const onShow = render;

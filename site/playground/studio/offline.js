// Model files on this device (deployed releases only; the development server has no service worker). Registers /sw.js, shows how much each model keeps
// in this browser, lets the visitor remove them or stop keeping them, and tells the cards whether a model's files will be downloaded or read back.
// Everything stays in this browser: the service worker only answers requests of this site's pages and model workers from Cache Storage.
const $ = (id) => document.getElementById(id);
const PRODUCTION = !!document.querySelector('meta[name="vs-release"]');
const GROUP = {'zipvoice-hybrid': 'zipvoice', zipvoice: 'zipvoice', chatterbox: 'chatterbox', f5: 'f5'};
const NAME = {zipvoice: 'ZipVoice', chatterbox: 'Chatterbox', f5: 'F5-TTS'};
// First-use download per model on a WebGPU device (from the release inventory: deploy/releases/*.json); ZipVoice without WebGPU needs about 0.2 GB.
const FIRST_USE = {zipvoice: 'about 0.25 GB', chatterbox: 'about 1.5 GB', f5: 'about 0.8 GB'};
const gb = (b) => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB';
let usage = null, reg = null;

async function ask(msg) {   // request/response with the service worker over a MessageChannel
  const sw = reg?.active || navigator.serviceWorker?.controller; if (!sw) return null;
  return new Promise((res) => { const ch = new MessageChannel(); const t = setTimeout(() => res(null), 5000); ch.port1.onmessage = (e) => { clearTimeout(t); res(e.data); }; sw.postMessage(msg, [ch.port2]); });
}
const store = window.vsStore = {
  production: PRODUCTION,
  saved: (id) => !!usage?.models?.[GROUP[id]]?.bytes,
  async refresh() { if (reg) { usage = await ask({type: 'usage'}) || usage; paint(); } return usage; },
  async clear(model) { usage = await ask({type: 'clear', model}) || usage; paint(); },
  async keep(on) { usage = await ask({type: 'keep', on}) || usage; paint(); },
  lastError: '',
};

function paintCards() {
  for (const card of document.querySelectorAll('.card[data-card]')) {
    const g = GROUP[card.dataset.card]; let el = card.querySelector('.tile-dl');
    if (!el) { el = document.createElement('span'); el.className = 'tile-dl'; card.querySelector('.tile-body').append(el); }
    const saved = usage?.models?.[g]?.bytes;   // sizes are not shown on the card itself (plain-language cards); see #dlNote and My creations
    el.textContent = saved ? 'Saved on this device' : ''; el.hidden = !saved;
  }
}
function paintNote() {   // first-use download sizes, under the cards (from the release inventory)
  const n = $('dlNote'); if (!n) return; const m = usage?.models || {}, left = Object.keys(NAME).filter((g) => !m[g]?.bytes);
  n.textContent = !left.length ? 'All three models are saved on this device.' : `The first time you use a model, its files are downloaded${PRODUCTION ? ' and kept in this browser' : ''}: ${left.map((g) => `${NAME[g]} ${FIRST_USE[g]}`).join(', ')}.`;
}
function panel() {
  const lib = $('libraryRoot'); if (!lib || !PRODUCTION) return null;
  let p = $('modelStore');
  if (!p) {
    p = document.createElement('section'); p.id = 'modelStore'; p.className = 'model-store'; p.setAttribute('aria-labelledby', 'msTitle');
    p.innerHTML = `<h2 id="msTitle">Model files on this device</h2>
      <p class="fine">Each model downloads its files the first time you use it. They are kept in this browser so the next visit does not download them again, and so the page works without a connection. They contain no recordings or text of yours.</p>
      <label class="switch"><input type="checkbox" id="msKeep"> <span>Keep downloaded models on this device</span></label>
      <ul class="ms-list" id="msList"></ul><p class="fine" id="msQuota"></p>
      <button type="button" class="text-btn quiet" id="msClear">Remove all downloaded models</button>`;
    lib.append(p);
    p.querySelector('#msKeep').addEventListener('change', (e) => store.keep(e.target.checked));
    p.querySelector('#msClear').addEventListener('click', () => { if (confirm('Remove all downloaded model files from this browser? They will download again the next time you use a model.')) store.clear(null); });
    p.addEventListener('click', (e) => { const b = e.target.closest('[data-ms-clear]'); if (b) store.clear(b.dataset.msClear); });
  }
  return p;
}
async function paint() {
  paintCards(); paintNote();
  const p = panel(); if (!p) return;
  const m = usage?.models || {};
  p.querySelector('#msKeep').checked = usage ? usage.keep : true; p.querySelector('#msKeep').disabled = !usage;
  p.querySelector('#msList').innerHTML = Object.keys(NAME).map((g) => `<li><b>${NAME[g]}</b> <span>${m[g]?.bytes ? gb(m[g].bytes) + ' saved' : 'not downloaded'}</span>${m[g]?.bytes ? ` <button type="button" class="text-btn quiet" data-ms-clear="${g}">Remove</button>` : ''}</li>`).join('');
  p.querySelector('#msClear').hidden = !Object.values(m).some((x) => x.bytes);
  let q = ''; try { const e = await navigator.storage.estimate(); q = `This website uses ${gb(e.usage || 0)} of the ${gb(e.quota || 0)} this browser allows it${await navigator.storage.persisted?.() ? '' : '; the browser may remove saved models if the disk gets full'}.`; } catch {}
  p.querySelector('#msQuota').textContent = (reg ? '' : 'Saving models on this device is not available in this browser (no service worker). ') + q + (store.lastError ? ` Last problem saving a file: ${store.lastError}` : '');
}

paintCards(); paintNote();
if (PRODUCTION && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.source !== 'vs-sw') return;
    if (e.data.type === 'integrity-error') { store.lastError = `${e.data.path}: ${e.data.message}. The file was not used or kept.`; window.pg?.state && (window.pg.state.cacheErrors ??= []).push({...e.data, at: Date.now()}); document.dispatchEvent(new CustomEvent('vs:integrity')); }
    if (e.data.type === 'cache-error') { store.lastError = `${e.data.path.split('/').pop()}: ${e.data.message}`; window.pg?.state && (window.pg.state.cacheErrors ??= []).push(e.data); }
    store.refresh();
  });
  // The site root is two levels above this module (…/<site>/playground/studio/offline.js), so the same code works at / and under a GitHub Pages
  // project path such as /VoiceStudio/.
  const SITE = new URL('../../', import.meta.url).href;
  navigator.serviceWorker.register(SITE + 'sw.js', {scope: SITE}).then(async (r) => { reg = r; await navigator.serviceWorker.ready; reg = await navigator.serviceWorker.getRegistration(SITE) || r; store.refresh(); })
    .catch((e) => { store.lastError = String(e.message || e); paint(); });
} else paint();
document.addEventListener('pg:load', () => store.refresh());

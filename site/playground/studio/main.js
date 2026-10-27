// Voice Studio 2.0 shell: the four top-level views (Create = the existing four scenes, Compare, My creations, Journey), the model "Learn more" sheet and
// the verification list in Developer diagnostics. Navigation uses the History API, so Back/Forward move between views and scenes alike.
import * as compare from './compare.js';
import * as library from './library.js';
import * as journey from './journey.js';
import * as player from './player.js';
import {INFO, VERIFY_LABEL} from './models-info.js';
import * as device from './device.js';
import './offline.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const MODULES = {compare, library, journey};
const TITLES = {create: null, compare: 'Compare models', library: 'My creations', journey: 'Project Journey'};

const studio = window.studio = {
  view: 'create', compare,
  show(name, {push = true} = {}) {
    if (!(name in TITLES) || name === this.view) { if (name === this.view && name !== 'create') MODULES[name]?.onShow?.(); return; }
    player.stop(); if (name !== 'create') { const o = $('out'), r = $('refAudio'); if (o && !o.paused) o.pause(); if (r && !r.paused) r.pause(); }
    const from = this.view; this.view = name; document.body.dataset.view = name;
    $('stage').hidden = name !== 'create';
    document.querySelectorAll('.view').forEach((v) => { const on = v.dataset.view === name; v.hidden = !on; if (on) { v.dataset.enter = ''; setTimeout(() => delete v.dataset.enter, 700); v.scrollTop = 0; } });
    document.querySelectorAll('.views [data-view-link], .bar .about').forEach((a) => { if (a.dataset.viewLink === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (name === 'create') { if (push) history.pushState({scene: window.ux.scene}, '', '#' + window.ux.scene); dispatchEvent(new Event('resize')); requestAnimationFrame(() => document.querySelector(`#scene-${window.ux.scene} h1`)?.focus({preventScroll: true})); }
    else { if (push) history.pushState({view: name}, '', '#' + name); MODULES[name].onShow?.(); requestAnimationFrame(() => $(`view-${name}`).querySelector('h1')?.focus({preventScroll: true})); }
    $('announce').textContent = TITLES[name] || 'Create';
    document.title = TITLES[name] ? `${TITLES[name]} — Voice Studio` : 'Voice Studio — on-device speech';
    return from;
  },
  toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 6000); },
};
compare.mount($('compareRoot')); library.mount($('libraryRoot')); journey.mount($('journeyRoot'));
document.addEventListener('pg:assets', () => device.repaint());   // a model whose files are unavailable is shown as unavailable on its card
const libShow = library.onShow; MODULES.library = {...library, onShow: () => { libShow(); window.vsStore?.refresh(); }};

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-view-link]'); if (!a) return;
  e.preventDefault(); const v = a.dataset.viewLink;
  if (v === 'create') { if (studio.view === 'create') return; studio.show('create'); } else studio.show(v);
});
$('toCompare').addEventListener('click', () => { compare.prefill({text: null, models: [window.pg.state.tile?.id].filter(Boolean)}); studio.show('compare'); });

// ---- "Learn more" sheet ---------------------------------------------------------------------------------------------------
function verification(id) {
  return INFO[id].verification.map((v) => `<li data-level="${v.level}"><b>${VERIFY_LABEL[v.level]}</b> ${esc(v.text)}</li>`).join('');
}
function onDevice(id) {   // from studio/device.js: what this browser offers, in plain words
  const s = window.pg.state.support?.[id]; if (!s) return '';
  return `<section class="mi-device" data-level="${s.level}"><h3>On this device</h3><p>${s.level === 'unavailable' ? 'Not available: ' : s.level === 'slow' ? 'Works, slowly: ' : ''}${esc(s.text)}</p></section>`;
}
function learn(id) {
  const c = INFO[id], m = window.pg.models.find((x) => x.id === id), d = $('modelInfo');
  $('miBody').innerHTML = `<header><h2 id="miTitle">${esc(c.name)}</h2><button type="button" class="text-btn" data-close aria-label="Close">Close</button></header>
    <p class="mi-lead">${esc(c.about)}</p>
    <div class="mi-cols"><section><h3>Good for</h3><ul>${c.good.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>
      <section><h3>Keep in mind</h3><ul>${c.mind.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section></div>
    <section><h3>Languages</h3><p>${c.langs.map(([, n]) => n).join(' and ')}${m.languages.includes('zh+en') ? '. Mixed Mandarin–English sentences are accepted but experimental.' : ' only.'}</p></section>
    <section><h3>Settings you can change</h3><p>${esc(c.settings)} In Advanced settings.</p></section>
    ${onDevice(id)}
    <section><h3>What has been verified</h3><ul class="verify">${verification(id)}</ul></section>
    <details><summary>How it works</summary><p>${esc(c.how)}</p><p class="fine">Download: ${esc(c.size)}. ${esc(c.license)} <a href="credits.html" target="_blank" rel="noopener">Credits and licences</a></p><p class="fine">Evidence: ${c.evidence.map((p) => `<a href="../${esc(p)}" target="_blank" rel="noopener">${esc(p)}</a>`).join(' · ')}</p></details>
    <footer>${window.pg.state.unavailable?.[id] ? `<p class="fine">${esc(c.name)} cannot run on this device.</p>` : `<button type="button" class="next" data-choose="${id}"><span>Use ${esc(c.name)}</span></button>`}</footer>`;
  d.showModal();
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-learn]'); if (b) { e.preventDefault(); e.stopPropagation(); learn(b.dataset.learn); } });
$('modelInfo').addEventListener('click', (e) => {
  if (e.target === $('modelInfo') || e.target.closest('[data-close]')) { $('modelInfo').close(); return; }
  const c = e.target.closest('[data-choose]'); if (c) { $('modelInfo').close(); window.ux.confirm(c.dataset.choose); }
});

// ---- Developer diagnostics: verification of the selected model -------------------------------------------------------
const paintVerify = () => { const id = window.pg.state.tile?.id; if (id && INFO[id]) $('verifyList').innerHTML = verification(id); };
document.addEventListener('pg:model', paintVerify); paintVerify();
// GPU adapter description for the Compare conditions (no fingerprinting beyond what the comparison report needs; stays in the tab)
navigator.gpu?.requestAdapter().then((a) => { const i = a?.info; if (i) window.pg.state.gpuAdapter = [i.vendor, i.architecture].filter(Boolean).join(' / '); }).catch(() => {});

// Deep link (e.g. …/playground/#journey for a visitor who only wants the project history)
if (window.ux.bootView) studio.show(window.ux.bootView);

// Project Journey: renders studio/journey.json (the editable source of every milestone, metric and reference). Bars are drawn only for metrics
// marked "comparable" (same conditions before and after); everything else is text. Diagrams use measured numbers from the docs cited next to them.
import {hosting} from '../adapters/common.js';
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const code = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
const fmt = (v) => v === 0 ? '0' : Math.abs(v) >= 10 ? v.toFixed(v % 1 ? 2 : 0) : String(v);
let loaded = false, root = null, published = null;   // published: the docs a deployed release includes (hosting.json "docs"); null = all (development)

function bars(m) {   // before/after under identical conditions; lower is better for every metric in this file except the F5 ODE end time
  const max = Math.max(m.before, m.after) || 1, w = (v) => Math.max(1.5, (v / max) * 100);
  return `<figure class="jr-bars"><figcaption>${code(m.label)}</figcaption>
    <div class="bar-row"><span class="bl">${esc(m.beforeLabel)}</span><span class="track"><i class="b0" style="width:${w(m.before)}%"></i></span><span class="bv">${esc(m.beforeText || fmt(m.before))} ${esc(m.unit)}</span></div>
    <div class="bar-row"><span class="bl">${esc(m.afterLabel)}</span><span class="track"><i class="b1" style="width:${w(m.after)}%"></i></span><span class="bv">${esc(m.afterText || fmt(m.after))} ${esc(m.unit)}</span></div>
    ${m.note ? `<p class="fine">${code(m.note)}</p>` : ''}</figure>`;
}
const metric = (m) => m.comparable ? bars(m) : `<p class="jr-metric"><b>${esc(m.value)}</b> <span>${code(m.label)}${m.note ? ' — ' + code(m.note) : ''}</span></p>`;

const DIAGRAM = {
  // ZipVoice hybrid: where each stage runs (docs/playground_hybrid.md, "What the hybrid is")
  hybrid: () => `<figure class="jr-diagram" aria-label="ZipVoice hybrid pipeline: text front end and encoder in WebAssembly, four decoder steps on the GPU with WebGPU, vocoder in WebAssembly">
    <div class="pipe"><div class="st cpu"><b>Text front end + encoder</b><small>WebAssembly (sherpa-onnx)</small></div><span class="arr" aria-hidden="true">→</span>
    <div class="st gpu"><b>Flow-matching decoder × 4 steps</b><small>WebGPU · FP32 (dequantised from INT8)</small></div><span class="arr" aria-hidden="true">→</span>
    <div class="st cpu"><b>Vocos vocoder</b><small>WebAssembly</small></div><span class="arr" aria-hidden="true">→</span><div class="st out"><b>WAV</b><small>in the tab</small></div></div>
    <figcaption>The decoder is ≈ 95 % of the work, so only it moves to the GPU. Without WebGPU the same model runs entirely in WebAssembly.</figcaption></figure>`,
  // Chatterbox readiness split, integrated benchmark medians (docs/chatterbox_fastload.md §4)
  coldstart: () => { const max = 38.37, seg = (v, c, t) => `<i class="${c}" style="width:${(v / max) * 100}%" title="${t}: ${v} s"></i>`;
    return `<figure class="jr-diagram" aria-label="Chatterbox model-ready time split: stock 38.37 seconds of which the conditional decoder session is 36.73; patched 3.77 seconds of which the decoder is 2.23">
      <div class="stack"><span class="bl">Stock</span><span class="track">${seg(36.73, 'b0', 'conditional_decoder session')}${seg(1.17, 'b2', 'other 3 sessions')}${seg(38.37 - 36.73 - 1.17, 'b3', 'files + setup')}</span><span class="bv">38.37 s</span></div>
      <div class="stack"><span class="bl">Patched</span><span class="track">${seg(2.23, 'b1', 'conditional_decoder session')}${seg(1.12, 'b2', 'other 3 sessions')}${seg(3.77 - 2.23 - 1.12, 'b3', 'files + setup')}</span><span class="bv">3.77 s</span></div>
      <p class="legend"><span><i class="b0"></i>decoder session (stock)</span><span><i class="b1"></i>decoder session (patched)</span><span><i class="b2"></i>other three sessions</span><span><i class="b3"></i>files and setup</span></p>
      <figcaption>Medians of 5 page reloads. Only the start-up changes; generating speech takes the same time with either runtime.</figcaption></figure>`; },
};

function ref(d) {   // documents in this branch (and, in a release, published with it) are linked; references to other branches and internal records are text
  const path = d.split(' ')[0];
  if (published && /^docs\//.test(path) && !/\(branch/.test(d) && !published.includes(path)) return `<span>${esc(d)} (research repository)</span>`;
  return /\(branch/.test(d) || !/^docs\//.test(path) ? `<span>${esc(d)}</span>` : `<a href="../${esc(path)}" target="_blank" rel="noopener">${esc(d)}</a>`;
}
function milestone(m, i) {
  return `<li class="jr-item" data-phase="${esc(m.phase)}" id="m-${esc(m.id)}">
    <div class="jr-when"><time>${esc(m.date)}</time><span class="jr-phase">${esc(m.phase)}</span></div>
    <article class="jr-card"><h2>${esc(m.title)}</h2><p class="jr-problem">${code(m.problem)}</p>
      ${m.metrics.map(metric).join('')}${m.diagram && DIAGRAM[m.diagram] ? DIAGRAM[m.diagram]() : ''}
      <details class="jr-more"${i === undefined ? '' : ''}><summary>Engineering details</summary>
        <h3>Why this approach</h3><p>${code(m.why)}</p>
        <h3>What was built</h3><ul>${m.what.map((x) => `<li>${code(x)}</li>`).join('')}</ul>
        <h3>Evidence</h3><ul>${m.evidence.map((x) => `<li>${code(x)}</li>`).join('')}</ul>
        <h3>Limitations</h3><ul>${m.limitations.map((x) => `<li>${code(x)}</li>`).join('')}</ul>
        <p class="jr-refs">${m.refs.commits.length ? `Commits ${m.refs.commits.map((c) => `<code>${esc(c)}</code>`).join(' ')}` : ''}${m.refs.docs.length ? ` · ${m.refs.docs.map(ref).join(' · ')}` : ''}</p>
      </details></article></li>`;
}
async function render() {
  if (loaded || !root) return;
  published = (await hosting)?.docs || null;
  let J; try { J = await (await fetch(new URL('./journey.json', import.meta.url))).json(); } catch (e) { root.innerHTML = `<p class="error">The journey data could not be loaded (${esc(e.message || e)}).</p>`; return; }
  loaded = true;
  const phases = [...new Set(J.milestones.map((m) => m.phase))];
  root.innerHTML = `<header class="view-head jr-head"><h1 id="jrTitle" tabindex="-1">${esc(J.title)}</h1><p class="lede">${esc(J.subtitle)}</p></header>
    <div class="jr-highlights">
      <a href="#m-hybrid" class="hl"><b>≈ 16×</b><span>faster ZipVoice generation on the GPU</span><small>RTF 3.6 → 0.22, same English sentence and recording</small></a>
      <a href="#m-fastload" class="hl"><b>38.4 → 3.8 s</b><span>Chatterbox ready after a page load</span><small>start-up only; generation speed unchanged</small></a>
      <a href="#m-f5fix" class="hl"><b>t = 1</b><span>F5 sampling completes at every step setting</span><small>was t = 0.275 at the default</small></a></div>
    <p class="jr-scope">${esc(J.scope)}</p>
    <div class="jr-filter" role="group" aria-label="Show milestones">${['All', ...phases].map((p, k) => `<button type="button" data-ph="${esc(p)}" aria-pressed="${k === 0}">${esc(p)}</button>`).join('')}</div>
    <ol class="jr-line">${J.milestones.map((m, i) => milestone(m, i)).join('')}</ol>
    <p class="fine jr-foot">Source: <code>playground/studio/journey.json</code>, updated ${esc(J.updated)}. Commits are in this repository's history; documents are in <code>docs/</code>.</p>`;
  root.querySelector('.jr-filter').addEventListener('click', (e) => { const b = e.target.closest('[data-ph]'); if (!b) return;
    root.querySelectorAll('.jr-filter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    root.querySelectorAll('.jr-item').forEach((li) => { li.hidden = b.dataset.ph !== 'All' && li.dataset.phase !== b.dataset.ph; }); });
  if (window.studio?.view === 'journey') root.querySelector('h1').focus({preventScroll: true});   // first visit: the heading exists only now
  root.querySelectorAll('.jr-highlights a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); const t = root.querySelector(a.getAttribute('href')); if (t) { t.hidden = false; t.scrollIntoView({block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}); t.querySelector('details')?.setAttribute('open', ''); } }));
}
export function mount(el) { root = el; }
export const onShow = render;

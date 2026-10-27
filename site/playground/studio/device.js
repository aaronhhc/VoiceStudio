// What this browser and device can run, from feature detection only (never the user-agent string), and what that means for each model.
// Card wording avoids technical terms (WebGPU, MB/GB: see test_ux/test_studio); Developer diagnostics and the device note name them.
// Verdicts: ok | slow (runs, but on the CPU) | unavailable (cannot run here: the card, Compare and reuse refuse it with the reason).
// Nothing here is sent anywhere; the adapter description stays in the tab (Developer diagnostics).
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
// smallest module using a v128 instruction (WebAssembly SIMD); all runtimes here are SIMD builds
const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export async function detect() {
  const c = {secure: window.isSecureContext, mic: !!navigator.mediaDevices?.getUserMedia, wasm: typeof WebAssembly === 'object', simd: false,
    webgpuApi: !!navigator.gpu, adapter: false, f16: false, device: null, deviceError: '', limits: null, adapterInfo: '',
    memoryGB: navigator.deviceMemory ?? null, cores: navigator.hardwareConcurrency ?? null, touch: matchMedia('(pointer: coarse)').matches, quota: null, usage: null, persisted: null};
  try { c.simd = c.wasm && WebAssembly.validate(SIMD); } catch {}
  if (navigator.gpu) {
    try {
      const a = await navigator.gpu.requestAdapter();
      if (a) {
        c.adapter = true; c.f16 = a.features.has('shader-f16');
        c.limits = {maxBufferSize: a.limits.maxBufferSize, maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize};
        c.adapterInfo = a.info ? [a.info.vendor, a.info.architecture].filter(Boolean).join(' / ') : '';
        try { const d = await a.requestDevice(); c.device = true; d.destroy(); } catch (e) { c.device = false; c.deviceError = String(e.message || e); }
      }
    } catch (e) { c.deviceError = String(e.message || e); }
  }
  try { const e = await navigator.storage?.estimate(); if (e) { c.quota = e.quota ?? null; c.usage = e.usage ?? null; } c.persisted = await navigator.storage?.persisted?.() ?? null; } catch {}
  return c;
}

const gpu = (c) => c.adapter && c.device !== false;
export function support(id, c) {
  if (!c.wasm || !c.simd) return {level: 'unavailable', text: 'This browser cannot run the WebAssembly (SIMD) code the models need. Try a current Chrome, Edge, Safari or Firefox.'};
  if (id === 'zipvoice-hybrid') return gpu(c) ? {level: 'ok', text: 'Uses your graphics processor.'}
    : {level: 'slow', text: 'This browser cannot use your graphics processor, so ZipVoice runs on the main processor instead — several times slower.'};
  if (id === 'chatterbox') {
    if (c.memoryGB && c.memoryGB < 4) return {level: 'unavailable', text: 'Needs more memory than this device reports having.'};
    // measured without WebGPU on an Apple M5 Pro (Chrome, one WebAssembly thread): about 70 s for 3.5 s of speech (RTF ≈ 20), docs/cross_device_compatibility.md
    return gpu(c) ? {level: 'ok', text: 'Uses your graphics processor.'} : {level: 'slow', text: 'This browser cannot use your graphics processor, so Chatterbox runs on the main processor — very slow: on our test computer a short sentence took over a minute.'};
  }
  if (id === 'f5') {
    if (!c.webgpuApi) return {level: 'unavailable', text: 'Needs graphics-processor access that this browser does not offer. ZipVoice works here.'};
    if (!c.adapter) return {level: 'unavailable', text: 'The browser found no usable graphics processor, which this model needs. ZipVoice works here.'};
    if (c.device === false) return {level: 'unavailable', text: 'The graphics processor could not be started, and this model needs it. ZipVoice works here.'};
    if (!c.f16) return {level: 'unavailable', text: 'Needs a graphics processor with half-precision support, which this one lacks. ZipVoice works here.'};
    return {level: 'ok', text: 'Uses your graphics processor.'};
  }
  return {level: 'ok', text: ''};
}

const GB = (b) => b == null ? '—' : (b / 1e9).toFixed(b < 1e10 ? 1 : 0) + ' GB';
function paint(c) {
  const st = window.pg.state; st.device = c; st.support = {}; st.unavailable = st.unavailable || {};
  for (const card of document.querySelectorAll('.card[data-card]')) {
    const id = card.dataset.card, v = support(id, c), assetWhy = st.assetUnavailable?.[id];
    const level = assetWhy ? 'unavailable' : v.level, text = assetWhy || v.text; st.support[id] = {level, text};
    if (level === 'unavailable') st.unavailable[id] = text; else delete st.unavailable[id];
    card.dataset.support = level; const input = card.querySelector('input'); input.disabled = level === 'unavailable';
    let el = card.querySelector('.tile-device'); if (!el) { el = document.createElement('span'); el.className = 'tile-device'; card.querySelector('.tile-body').append(el); }
    el.textContent = level === 'ok' ? '' : (level === 'unavailable' ? (assetWhy ? 'Not available right now. ' : 'Not available on this device. ') : '') + text; el.hidden = level === 'ok';
  }
  const notes = [];
  if (!c.secure) notes.push('This page is not on a secure (https) connection, so the browser will not allow voice recording.');
  else if (!c.mic) notes.push('This browser does not offer microphone recording.');
  if (!gpu(c)) notes.push('This browser does not offer WebGPU (graphics-processor access), so models run on the main processor and take longer.');
  if (c.touch) notes.push('On phones and tablets the large model downloads and memory use may be impractical; ZipVoice is the lightest model.');
  $('deviceNote').textContent = notes.join(' '); $('deviceNote').classList.toggle('hide', !notes.length);
  const rows = [['Secure context (https)', c.secure ? 'yes' : 'no'], ['Microphone API', c.mic ? 'yes' : 'no'], ['WebAssembly SIMD', c.simd ? 'yes' : 'no'],
    ['WebGPU', !c.webgpuApi ? 'not offered' : !c.adapter ? 'no adapter' : c.device === false ? `device failed: ${c.deviceError}` : `yes${c.adapterInfo ? ' · ' + c.adapterInfo : ''}`],
    ['shader-f16', c.adapter ? (c.f16 ? 'yes' : 'no') : '—'], ['Max GPU buffer', c.limits ? GB(c.limits.maxBufferSize) : '—'],
    ['Device memory (browser report)', c.memoryGB ? `≥ ${c.memoryGB} GB` : 'not reported'], ['CPU threads', c.cores ?? '—'],
    ['Storage used / available', c.quota ? `${GB(c.usage)} / ${GB(c.quota)}${c.persisted ? ' (persistent)' : ''}` : 'not reported'],
    ...Object.entries(st.support).map(([id, s]) => [`→ ${window.pg.tileName(window.pg.models.find((m) => m.id === id))}`, `${s.level}${s.text ? ' — ' + s.text : ''}`])];
  const t = $('deviceTable'); if (t.tBodies) t.tBodies[0].innerHTML = rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  document.dispatchEvent(new CustomEvent('pg:device', {detail: c}));
}

let caps = null;
export const ready = detect().then((c) => { caps = c; paint(c); return c; });
export const repaint = () => caps && paint(caps);   // after the asset check marks a model unavailable

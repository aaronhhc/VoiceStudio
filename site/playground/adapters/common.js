// Shared helpers for the model adapters. Each adapter exports an object with this contract:
//   id, name, backend, languages[], size, needsRefText, refHint, params[], defaultVoice() (optional)
//   load({onProgress}) -> {loadMs, ...}      // lazy: called once, on first use
//   generate({text, ref:{samples,sampleRate}, refText, params, onProgress}) -> {samples, sampleRate, genMs, detail}
//   unload()                                 // terminates the worker so GPU/WASM memory is released

// Release asset map (playground/hosting.json, written by deploy/ghpages/build.mjs): {release, files: {repo path: URL}, repos: {id: {repo, host, revision, base}}}.
// null in development, where every file is served from this checkout.
export const hosting = fetch(new URL('../hosting.json', import.meta.url), {cache: 'no-cache'}).then((r) => (r.ok ? r.json() : null), () => null);
// True when the site's service worker controls the page (and so the model workers it starts): it then keeps one sha256-checked copy of every model
// file, and the workers' own caches stay off. Without it (development, a hard reload, a browser without service workers) the workers cache themselves.
export const swCached = () => !!navigator.serviceWorker?.controller;

export async function decodeAudio(arrayBuffer) { // -> mono Float32 at the file's native rate
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(arrayBuffer);
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i] / buf.numberOfChannels;
    }
    return {samples: out, sampleRate: buf.sampleRate};
  } finally { ctx.close(); }
}

export async function resample(ref, rate) { // -> new Float32Array at `rate`
  if (ref.sampleRate === rate) return ref.samples.slice();
  const src = new AudioBuffer({length: ref.samples.length, numberOfChannels: 1, sampleRate: ref.sampleRate});
  src.copyToChannel(ref.samples, 0);
  const off = new OfflineAudioContext(1, Math.ceil(ref.samples.length * rate / ref.sampleRate), rate);
  const node = off.createBufferSource(); node.buffer = src; node.connect(off.destination); node.start();
  return (await off.startRendering()).getChannelData(0).slice();
}

export function wavBlob(f32, sr) {
  const buf = new ArrayBuffer(44 + f32.length * 2), v = new DataView(buf);
  const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); s(8, 'WAVE'); s(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  s(36, 'data'); v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f32[i])) * 32767, true);
  return new Blob([buf], {type: 'audio/wav'});
}

export const hasCJK = (t) => /[㄀-鿿＀-￯]/.test(t);
export const hasLatin = (t) => /[A-Za-z]/.test(t);

// Cheap fingerprint of a reference clip so adapters can cache per-reference work (e.g. Chatterbox speaker encoding).
export function refKey(ref) {
  let h = 2166136261 >>> 0; const n = ref.samples.length, step = Math.max(1, Math.floor(n / 4096));
  for (let i = 0; i < n; i += step) h = Math.imul(h ^ Math.round(ref.samples[i] * 32767), 16777619) >>> 0;
  return `${n}:${ref.sampleRate}:${h}`;
}

// Request/response over a worker with error routing. Rejects on worker error events so nothing can hang silently.
export function rpcWorker(worker, {onEvent} = {}) {
  let pending = {};
  const fail = (err) => { Object.values(pending).forEach((p) => p.rej(err)); pending = {}; };
  worker.onerror = (e) => fail(new Error(e.message ? `worker error: ${e.message} ${e.filename || ''}:${e.lineno || ''}` : 'The model could not start: its background script failed to load (connection lost or file damaged). Reload the page and try again.'));
  worker.onmessageerror = () => fail(new Error('worker message could not be deserialized'));
  worker.onmessage = (e) => {
    const {type, data} = e.data;
    if (type === 'fatal' || type === 'error') return fail(new Error(`${data.where ? data.where + ': ' : ''}${data.message}`));
    if (type === 'stall') return fail(new Error(`download stalled: no bytes for ${data.secondsWithoutBytes}s during ${data.phase}`));
    if (onEvent) onEvent(type, data);
    if (pending[type]) { pending[type].res(data); delete pending[type]; }
  };
  return {
    expect: (type) => new Promise((res, rej) => { pending[type] = {res, rej}; }),
    send: (type, data, transfer) => worker.postMessage({type, data}, transfer || []),
  };
}

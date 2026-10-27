// My creations: every generated result (Create, Compare, Generate again) becomes one entry holding the WAV Blob (16-bit, the same Blob the page
// produced — no second copy) and its metadata. No model weights, sessions, sample arrays or reference recordings are kept here.
// Default: this tab only (gone when it closes). Optional, explicit opt-in: a copy on this device in IndexedDB. Nothing is ever uploaded.
import {peaks} from './wave.js';

export const LIMITS = {entries: 60, bytes: 150e6};   // session cap: the oldest entries are released first when either is exceeded
const FLAG = 'voiceStudio.keepOnDevice';               // localStorage flag only says "persistence was turned on"; the data itself lives in IndexedDB
const entries = [], urls = new Map(), subs = new Set();
const state = {persistent: false, dropped: 0, lastError: '', restored: 0};
const emit = () => subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

// ---- IndexedDB (opt-in) ----------------------------------------------------------------------------------------------------
let dbp = null;
const db = () => dbp ??= new Promise((res, rej) => {
  const r = indexedDB.open('voice-studio', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('creations', {keyPath: 'id'});
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('storage is blocked by another tab'));
});
const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('creations', mode); const out = fn(t.objectStore('creations')); t.oncomplete = () => res(out?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); }); };
const record = (e) => { const {hidden, ...rest} = e; return rest; };
async function save(e) {
  if (!state.persistent) return;
  try { await tx('readwrite', (s) => s.put(record(e))); e.stored = true; }
  catch (err) { e.stored = false; state.lastError = (err && err.name === 'QuotaExceededError') ? 'This device ran out of space for stored creations; new ones are kept for this session only.' : `Could not store on this device (${err?.message || err}); kept for this session only.`; }
  emit();
}
const unsave = (id) => state.persistent ? tx('readwrite', (s) => s.delete(id)).catch(() => {}) : Promise.resolve();
const flag = {get: () => { try { return localStorage.getItem(FLAG) === '1'; } catch { return false; } }, set: (on) => { try { on ? localStorage.setItem(FLAG, '1') : localStorage.removeItem(FLAG); } catch {} }};

export async function enablePersistence() {
  try { await db(); } catch (e) { state.lastError = `Storage on this device is not available here (${e.message || e}).`; emit(); return false; }
  state.persistent = true; state.lastError = ''; flag.set(true);
  for (const e of entries) await save(e);
  emit(); return true;
}
export async function disablePersistence() {   // turning it off deletes the stored copies; this session's list stays until the tab closes
  state.persistent = false; flag.set(false);
  try { await tx('readwrite', (s) => s.clear()); } catch {}
  entries.forEach((e) => { e.stored = false; }); emit();
}
async function restore() {
  if (!flag.get()) return;
  try {
    const rows = await tx('readonly', (s) => s.getAll());
    state.persistent = true;
    for (const r of (rows || []).sort((a, b) => b.ts - a.ts)) if (!entries.some((e) => e.id === r.id)) entries.push({...r, stored: true});
    entries.sort((a, b) => b.ts - a.ts); state.restored = rows?.length || 0; emit();
  } catch (e) { state.lastError = `Stored creations could not be read (${e.message || e}).`; emit(); }
}
export async function usage() { try { return await navigator.storage.estimate(); } catch { return null; } }

// ---- session list ------------------------------------------------------------------------------------------------------------
export const list = () => entries.filter((e) => !e.hidden);
export const all = () => entries;
export const get = (id) => entries.find((e) => e.id === id);
export const info = () => ({...state, count: list().length, bytes: entries.reduce((s, e) => s + e.bytes, 0)});
export const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
export function url(e) { if (!urls.has(e.id)) urls.set(e.id, URL.createObjectURL(e.blob)); return urls.get(e.id); }
function release(e) { const u = urls.get(e.id); if (u) { URL.revokeObjectURL(u); urls.delete(e.id); } }

export function add({run, blob, samples}, extra = {}) {
  const ux = window.ux, model = window.pg.models.find((m) => m.id === run.requestedModel);
  const e = {id: crypto.randomUUID(), ts: run.ts, source: run.source, requestedModel: run.requestedModel, model: run.model, modelName: window.pg.tileName(model),
    text: run.text, targetLang: ux?.detectLang ? ux.detectLang(run.text) : null, refSeconds: run.refSeconds, refLang: ux?.recordedLang ?? null, refName: run.refName,
    params: run.params, backendUsed: run.backendUsed, ortRuntime: run.detail?.ortRuntime || null, fellBack: run.fellBack, genMs: run.genMs, audioSec: run.audioSec, rtf: run.rtf,
    clickToResultMs: run.clickToResultMs, loadThisClickMs: run.loadThisClickMs, modelReused: run.modelReused, preloadedInBackground: run.preloadedInBackground,
    sampleRate: run.sampleRate, bytes: blob.size, blob, peaks: peaks(samples), stored: false, ...extra};
  entries.unshift(e); run.entryId = e.id;
  enforceLimits(); save(e); emit(); return e;
}
function enforceLimits() {
  let bytes = entries.reduce((s, e) => s + e.bytes, 0);
  while (entries.length > LIMITS.entries || bytes > LIMITS.bytes) { const old = entries.pop(); bytes -= old.bytes; release(old); unsave(old.id); state.dropped++; }
}
export function update(id, patch) { const e = get(id); if (!e) return; Object.assign(e, patch); if (!('hidden' in patch)) save(e); emit(); }
export function remove(id) {
  const i = entries.findIndex((e) => e.id === id); if (i < 0) return;
  const [e] = entries.splice(i, 1); release(e); unsave(id); emit();
}
export async function clear() {   // "Clear" = this session's list; with persistence on it also deletes every stored copy
  entries.splice(0).forEach(release);
  if (state.persistent) { try { await tx('readwrite', (s) => s.clear()); } catch {} }
  state.dropped = 0; emit();
}

// Every result from the shared pipeline lands here (app.js dispatches pg:result for Create, Compare and Generate again).
document.addEventListener('pg:result', (ev) => add(ev.detail, ev.detail.extra || {}));
restore();

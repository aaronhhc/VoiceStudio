// Playback controller for Compare and My creations: ONE shared <audio> element, so two outputs can never play at the same time, and playback only
// ever starts from a button press. It also pauses (and is paused by) the Create scene's own players, so the whole page has one voice at a time.
import {paint} from './wave.js';

const audio = document.getElementById('studioAudio');
if (new URLSearchParams(location.search).get('mute') === '1') audio.muted = true;   // automated runs
const players = new Map();   // key -> {el, btn, cv, time, pk, sec, getUrl}
let current = null;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function ui(key) {
  const p = players.get(key); if (!p) return;
  const on = current === key, playing = on && !audio.paused, frac = on && audio.duration ? audio.currentTime / audio.duration : 0;
  p.btn.toggleAttribute('data-playing', playing); p.btn.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${p.label}`);
  p.time.textContent = on && audio.currentTime > 0 ? `${fmt(audio.currentTime)} / ${fmt(p.sec)}` : fmt(p.sec);
  paint(p.cv, p.pk, frac);
}
export function toggle(key) {
  const p = players.get(key); if (!p) return;
  if (current === key) { if (audio.paused) { if (audio.ended) audio.currentTime = 0; audio.play(); } else audio.pause(); return; }
  const prev = current; current = key; audio.src = p.getUrl(); ui(prev); audio.play();
}
export function stop() { if (!audio.paused) audio.pause(); }
for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'emptied']) audio.addEventListener(ev, () => { if (ev === 'ended') audio.currentTime = 0; ui(current); });
// One voice at a time across the page: Create's result / recording players pause this one and vice versa.
document.addEventListener('play', (e) => {
  if (e.target === audio) document.querySelectorAll('audio').forEach((a) => { if (a !== audio && !a.paused) a.pause(); });
  else if (!audio.paused) audio.pause();
}, true);

// Mount a compact player (play/pause, waveform with playhead and click-to-seek, time) into `host`. getUrl is called on first play only.
export function mount(host, {key, label, pk, sec, getUrl}) {
  host.innerHTML = `<div class="mini"><button type="button" class="play small"><svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg><svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg></button>
    <canvas height="40" role="img" aria-label="Waveform of ${label}"></canvas><span class="rv-time"></span></div>`;
  const el = host.firstElementChild, p = {el, btn: el.querySelector('button'), cv: el.querySelector('canvas'), time: el.querySelector('.rv-time'), pk, sec, label, getUrl};
  players.set(key, p);
  p.btn.addEventListener('click', () => toggle(key));
  p.cv.addEventListener('click', (e) => { if (current !== key || !audio.duration) return; const r = p.cv.getBoundingClientRect(); audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration; });
  requestAnimationFrame(() => ui(key));
  return el;
}
export function unmount(key) {   // the player's DOM is going away (re-render or deletion)
  if (current === key) { audio.pause(); audio.removeAttribute('src'); audio.load(); current = null; }
  players.delete(key);
}
export function release(key) { unmount(key); }
export const repaintAll = () => players.forEach((_, k) => ui(k));
addEventListener('resize', repaintAll);

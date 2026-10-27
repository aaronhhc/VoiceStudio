// In-browser microphone capture to raw mono Float32 PCM. Nothing is uploaded: samples stay in this tab's memory.
// Playback is never started here; the caller only exposes a WAV blob for an <audio controls> element the user presses.
const WORKLET_URL = new URL('./recorder-worklet.js', import.meta.url);   // the AudioWorklet (a static file, allowed by the deployed CSP)

export const MAX_SECONDS = 20, MIN_SECONDS = 3;

export class Recorder {
  // constraints are off on purpose: echo cancel / noise suppression / AGC alter timbre and hurt cloning fidelity.
  constructor({onLevel} = {}) { this.onLevel = onLevel; this.chunks = []; this.active = false; }
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is not available (needs a secure context: https or localhost).');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
    } catch (e) {
      const msg = {NotAllowedError: 'Microphone permission was denied. Click the icon at the left of the address bar, allow the microphone for this site, then press Start recording again.',
        NotFoundError: 'No microphone was found. Connect one and try again.', NotReadableError: 'The microphone is in use by another application.'}[e.name];
      throw new Error(msg || 'Could not open the microphone: ' + e.message);
    }
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(WORKLET_URL);
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'tap', {numberOfInputs: 1, numberOfOutputs: 0});
    this.chunks = []; this.n = 0; this.peak = 0; this.active = true;
    this.node.port.onmessage = (ev) => {
      if (!this.active) return;
      const c = ev.data; this.chunks.push(c); this.n += c.length;
      let p = 0; for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]));
      this.peak = Math.max(this.peak, p);
      this.onLevel && this.onLevel({level: p, seconds: this.n / this.ctx.sampleRate});
    };
    this.src.connect(this.node);   // numberOfOutputs 0: the mic is never routed to the speakers
  }
  seconds() { return this.ctx ? this.n / this.ctx.sampleRate : 0; }
  async stop() {
    this.active = false;
    const sr = this.ctx.sampleRate, out = new Float32Array(this.n);
    let o = 0; for (const c of this.chunks) { out.set(c, o); o += c.length; }
    this.stream.getTracks().forEach((t) => t.stop());
    try { this.src.disconnect(); } catch {}
    await this.ctx.close();
    this.chunks = [];
    return {samples: out, sampleRate: sr};
  }
  cancel() { this.active = false; this.stream?.getTracks().forEach((t) => t.stop()); this.ctx?.close().catch(() => {}); this.chunks = []; }
}

// Quality hints (advisory only): a reference that is short, quiet, or clipped gives worse cloning.
export function assess({samples, sampleRate}) {
  const sec = samples.length / sampleRate; let peak = 0, sq = 0, clip = 0;
  for (const s of samples) { const a = Math.abs(s); if (a > peak) peak = a; sq += s * s; if (a >= 0.999) clip++; }
  const rmsDb = 20 * Math.log10(Math.sqrt(sq / samples.length) + 1e-9), warns = [];
  if (sec < MIN_SECONDS) warns.push(`Only ${sec.toFixed(1)} s recorded; read the whole passage (about 6–15 s).`);
  if (sec >= 1 && peak < 0.05) warns.push('Very quiet recording; check the microphone input level.');
  if (clip / samples.length > 0.001) warns.push('The recording is clipping; move back from the microphone or lower the input volume.');
  // valid = usable as a reference at all; the softer warnings above are advisory
  const valid = sec >= 2.5 && peak >= 0.02 && clip / samples.length < 0.05;
  if (!valid && sec >= 2.5 && peak < 0.02) warns.push('Nothing audible was recorded; check that the right microphone is selected.');
  return {sec, peak, rmsDb, warns, valid};
}

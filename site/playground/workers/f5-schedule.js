// Euler sampling plan for the F5 ONNX export (pure, no browser APIs; unit-tested by f5/test_schedule.mjs).
// The exported transformer has the sway-sampling Euler schedule BAKED IN: `time_step` indexes a 32-entry time-embedding table
// and a 31-entry dt table (sum = 1.0; extracted from transformer_fp32.onnx, max deviation from F5's sway formula 1.2e-7).
// Running fewer than 31 steps with consecutive indices therefore stops the ODE early (15 steps -> t = 0.275) and leaves a noisy mel.
// To get a real N-step solve we pick N+1 of the 32 baked time points, feed time_step = start index, and rescale the returned
// update (out - y = v*dt_i) by (dt over the whole interval) / dt_i, i.e. Euler with the same velocity held over a longer interval.
// Subset-of-grid is an approximation of F5's own N-step grid (its time embedding cannot be recomputed from this export).
export const DT = [0.00128352642,0.0038471818,0.0064009428,0.00893843174,0.0114527941,0.0139378309,0.0163871646,0.0187942982,0.0211532712,0.0234579444,0.0257023573,0.0278807878,0.0299877524,0.0320175886,0.0339653492,0.0358258486,0.0375944972,0.0392665267,0.0408377647,0.0423041582,0.0436620116,0.0449078679,0.0460383296,0.0470504761,0.0479422808,0.0487105846,0.0493538976,0.0498707891,0.0502594709,0.050519228,0.0506490469];
export const TCUM = DT.reduce((a, d) => (a.push(a[a.length - 1] + d), a), [0]);
export function eulerPlan(nSteps, schedule = 'stride') { // -> [{idx, scale}] ; 'truncate' reproduces the original (broken for N<31) behaviour
  nSteps = Math.max(1, Math.min(31, nSteps));
  if (schedule === 'truncate') return /* DIAGNOSTIC ONLY: original broken behaviour, never the default */ Array.from({length: nSteps}, (_, i) => ({idx: i, scale: 1, t1: TCUM[i + 1]}));
  const pts = Array.from({length: nSteps + 1}, (_, k) => Math.round(k * 31 / nSteps));
  return pts.slice(0, -1).map((idx, k) => ({idx, scale: pts[k + 1] - idx === 1 ? 1 : (TCUM[pts[k + 1]] - TCUM[idx]) / DT[idx], t1: TCUM[pts[k + 1]]}));
}

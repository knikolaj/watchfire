// Tiny synth for status notifications.
// Web Audio AudioContext is suspended until a user gesture; enable() unlocks it.

let ctx = null;
let unlocked = false;

export function enable() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  unlocked = true;
}

function tone({ freq, duration = 0.4, type = "sine", gain = 0.15, attack = 0.01, release = 0.2 }) {
  if (!unlocked || !ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.linearRampToValueAtTime(0, t + duration + release);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration + release + 0.05);
}

/** Two ascending notes — needs your attention. */
export function bell() {
  tone({ freq: 880,  duration: 0.18, type: "triangle", gain: 0.18 });
  setTimeout(() => tone({ freq: 1175, duration: 0.28, type: "triangle", gain: 0.18 }), 160);
}

/** Single soft note — task finished. */
export function chime() {
  tone({ freq: 660, duration: 0.22, type: "sine", gain: 0.12 });
}

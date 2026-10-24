const STORAGE_KEY = 'cv-mix';
const FREQUENCY_BINS = 512;
const WAVEFORM_SAMPLES = 2048;

const PARAM_RANGE = {
  eqLow: [-20, 20],
  eqMid: [-20, 20],
  eqHigh: [-20, 20],
  filterHp: [20, 20000],
  filterLp: [20, 20000],
  drive: [0, 20],
  reverb: [0, 1],
  compThresh: [-60, 0],
  compRatio: [1, 20],
  stereoWidth: [0, 2],
  pan: [-1, 1],
  blend: [0, 1],
  volume: [0, 1],
  tapeSpeed: [0.5, 1.5],
};

const mixDefaults = {
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  filterHp: 20,
  filterLp: 20000,
  drive: 0,
  reverb: 0,
  compThresh: -24,
  compRatio: 4,
  stereoWidth: 1,
  pan: 0,
  blend: 1,
  volume: 0.5,
  tapeSpeed: 1,
  mono: false,
  limiter: true,
  currentTime: 0,
};

const score = document.getElementById('score');
score.loop = true;
score.volume = 0.5;
// Tape speed is varispeed: pitch follows the rate.
score.preservesPitch = false;
score.webkitPreservesPitch = false;

const listeners = new Set();
const mix = { ...mixDefaults, ...readStoredMix() };

let sessionOpen = false;
let playheadReady = mix.currentTime <= 0;
let persistTimer = 0;
let audioCtx = null;
let eqLow = null;
let eqMid = null;
let eqHigh = null;
let filterHp = null;
let filterLp = null;
let distortion = null;
let reverbWet = null;
let reverbDry = null;
let dryNode = null;
let wetNode = null;
let compressor = null;
let masterVol = null;
let stereoWidthSide = null;
let stereoPanner = null;
let limiterSend = null;
let limiterBypass = null;
let analyser = null;
let waveAnalyser = null;

score.playbackRate = mix.tapeSpeed;
restorePlayhead();

score.addEventListener('play', () => emit('transport'));
score.addEventListener('pause', () => emit('transport'));
score.addEventListener('timeupdate', () => {
  if (!playheadReady) return;
  mix.currentTime = score.currentTime;
  emit('time');
  schedulePersist();
});

export { FREQUENCY_BINS, WAVEFORM_SAMPLES };

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMix() {
  return { ...mix };
}

export function isSessionOpen() {
  return sessionOpen;
}

export function isPlaying() {
  return !score.paused;
}

export function hasAnalyser() {
  return analyser !== null;
}

export function playbackTime() {
  return {
    current: score.currentTime || 0,
    duration: Number.isFinite(score.duration) ? score.duration : 0,
  };
}

export function setMixParam(name, next) {
  const apply = paramAppliers[name];
  if (!apply) throw new Error(`Unknown mix param: ${name}`);
  apply(clampParam(name, Number(next)));
  persistMix();
}

export function enableMono() {
  mix.mono = true;
  if (stereoWidthSide) stereoWidthSide.gain.value = 0;
  persistMix();
}

export function disableMono() {
  mix.mono = false;
  if (stereoWidthSide) stereoWidthSide.gain.value = mix.stereoWidth;
  persistMix();
}

export function enableLimiter() {
  mix.limiter = true;
  routeLimiter();
  persistMix();
}

export function disableLimiter() {
  mix.limiter = false;
  routeLimiter();
  persistMix();
}

export async function toggleSession() {
  if (sessionOpen) {
    closeSession();
    return;
  }
  sessionOpen = true;
  await startPlayback();
}

export async function togglePlayback() {
  if (!score.paused) {
    score.pause();
    return;
  }
  sessionOpen = true;
  await startPlayback();
}

export function seekToFraction(fraction) {
  if (!Number.isFinite(score.duration) || score.duration <= 0) return;
  const clamped = Math.min(1, Math.max(0, fraction));
  playheadReady = true;
  score.currentTime = clamped * score.duration;
  mix.currentTime = score.currentTime;
  emit('time');
  persistMix();
}

const sharedFrequency = new Uint8Array(FREQUENCY_BINS);
const sharedWaveform = new Float32Array(WAVEFORM_SAMPLES);
let frequencyCopiedAt = -Infinity;
let waveformCopiedAt = -Infinity;

export function copyFrequency(bins) {
  if (!analyser) return false;
  const now = performance.now();
  if (now - frequencyCopiedAt > 5) {
    analyser.getByteFrequencyData(sharedFrequency);
    frequencyCopiedAt = now;
  }
  if (bins !== sharedFrequency) bins.set(sharedFrequency);
  return true;
}

export function copyWaveform(samples) {
  if (!waveAnalyser) return false;
  const now = performance.now();
  if (now - waveformCopiedAt > 5) {
    waveAnalyser.getFloatTimeDomainData(sharedWaveform);
    waveformCopiedAt = now;
  }
  if (samples !== sharedWaveform) samples.set(sharedWaveform);
  return true;
}

export function gainReduction() {
  if (!compressor) return 0;
  const reduction = compressor.reduction;
  return typeof reduction === 'number' ? reduction : reduction.value || 0;
}

const paramAppliers = {
  eqLow(gain) {
    mix.eqLow = gain;
    if (eqLow) eqLow.gain.value = gain;
  },
  eqMid(gain) {
    mix.eqMid = gain;
    if (eqMid) eqMid.gain.value = gain;
  },
  eqHigh(gain) {
    mix.eqHigh = gain;
    if (eqHigh) eqHigh.gain.value = gain;
  },
  filterHp(frequency) {
    mix.filterHp = frequency;
    if (filterHp) filterHp.frequency.value = frequency;
  },
  filterLp(frequency) {
    mix.filterLp = frequency;
    if (filterLp) filterLp.frequency.value = frequency;
  },
  drive(amount) {
    mix.drive = amount;
    if (distortion) distortion.curve = distortionCurve(amount * 2);
  },
  reverb(amount) {
    mix.reverb = amount;
    if (reverbWet) {
      reverbWet.gain.value = amount;
      reverbDry.gain.value = 1 - amount;
    }
  },
  compThresh(db) {
    mix.compThresh = db;
    if (compressor) compressor.threshold.value = db;
  },
  compRatio(ratio) {
    mix.compRatio = ratio;
    if (compressor) compressor.ratio.value = ratio;
  },
  stereoWidth(width) {
    mix.stereoWidth = width;
    if (stereoWidthSide && !mix.mono) stereoWidthSide.gain.value = width;
  },
  pan(value) {
    mix.pan = value;
    if (stereoPanner) stereoPanner.pan.value = value;
  },
  blend(amount) {
    mix.blend = amount;
    if (!dryNode) return;
    dryNode.gain.value = Math.cos(amount * 0.5 * Math.PI);
    wetNode.gain.value = Math.cos((1 - amount) * 0.5 * Math.PI);
  },
  volume(gain) {
    mix.volume = gain;
    if (masterVol) masterVol.gain.value = gain;
  },
  tapeSpeed(rate) {
    mix.tapeSpeed = rate;
    score.playbackRate = rate;
  },
};

function closeSession() {
  sessionOpen = false;
  const alreadyPaused = score.paused;
  score.pause();
  if (alreadyPaused) emit('transport');
}

async function startPlayback() {
  buildGraph();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  try {
    await score.play();
  } catch (error) {
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') throw error;
    if (score.paused && error.name === 'NotAllowedError') {
      sessionOpen = false;
      emit('transport');
    }
  }
}

function buildGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  const source = audioCtx.createMediaElementSource(score);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = FREQUENCY_BINS * 2;
  analyser.smoothingTimeConstant = 0.8;
  waveAnalyser = audioCtx.createAnalyser();
  waveAnalyser.fftSize = WAVEFORM_SAMPLES;
  waveAnalyser.smoothingTimeConstant = 0.5;

  eqLow = biquad('lowshelf', 320);
  eqMid = biquad('peaking', 1000);
  eqMid.Q.value = 0.5;
  eqHigh = biquad('highshelf', 3200);
  filterLp = biquad('lowpass', 20000);
  filterHp = biquad('highpass', 20);

  distortion = audioCtx.createWaveShaper();
  distortion.oversample = '4x';
  compressor = audioCtx.createDynamicsCompressor();
  compressor.knee.value = 30;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.25;

  const reverb = audioCtx.createConvolver();
  reverb.buffer = reverbImpulse(audioCtx);
  reverbDry = audioCtx.createGain();
  reverbWet = audioCtx.createGain();
  dryNode = audioCtx.createGain();
  wetNode = audioCtx.createGain();
  masterVol = audioCtx.createGain();

  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.005;
  limiter.release.value = 0.05;
  limiterSend = audioCtx.createGain();
  limiterBypass = audioCtx.createGain();
  const output = audioCtx.createGain();

  const desk = wireStereo(audioCtx);

  source.connect(dryNode);
  source.connect(compressor);
  compressor.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(filterHp);
  filterHp.connect(filterLp);
  filterLp.connect(distortion);
  distortion.connect(reverbDry);
  distortion.connect(reverb);
  reverb.connect(reverbWet);
  reverbDry.connect(wetNode);
  reverbWet.connect(wetNode);
  dryNode.connect(desk.input);
  wetNode.connect(desk.input);
  desk.output.connect(masterVol);
  masterVol.connect(limiterSend);
  limiterSend.connect(limiter);
  limiter.connect(output);
  masterVol.connect(limiterBypass);
  limiterBypass.connect(output);
  output.connect(analyser);
  output.connect(waveAnalyser);
  analyser.connect(audioCtx.destination);

  applyStoredParams();
}

function biquad(type, frequency) {
  const filter = audioCtx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  return filter;
}

function wireStereo(ctx) {
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const midLeft = ctx.createGain();
  const midRight = ctx.createGain();
  const sideLeft = ctx.createGain();
  const sideRight = ctx.createGain();
  midLeft.gain.value = 0.5;
  midRight.gain.value = 0.5;
  sideLeft.gain.value = 0.5;
  sideRight.gain.value = -0.5;

  stereoWidthSide = ctx.createGain();
  const mid = ctx.createGain();
  mid.gain.value = 1;

  splitter.connect(midLeft, 0);
  splitter.connect(midRight, 1);
  splitter.connect(sideLeft, 0);
  splitter.connect(sideRight, 1);
  midLeft.connect(mid);
  midRight.connect(mid);
  sideLeft.connect(stereoWidthSide);
  sideRight.connect(stereoWidthSide);

  const left = ctx.createGain();
  const right = ctx.createGain();
  const invertedSide = ctx.createGain();
  invertedSide.gain.value = -1;
  mid.connect(left);
  stereoWidthSide.connect(left);
  mid.connect(right);
  stereoWidthSide.connect(invertedSide);
  invertedSide.connect(right);
  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);

  const panner = ctx.createStereoPanner();
  stereoPanner = panner;
  merger.connect(panner);
  return { input: splitter, output: panner };
}

function applyStoredParams() {
  for (const name of Object.keys(paramAppliers)) {
    paramAppliers[name](mix[name]);
  }
  routeLimiter();
  if (mix.mono && stereoWidthSide) stereoWidthSide.gain.value = 0;
}

function routeLimiter() {
  if (!limiterSend) return;
  limiterSend.gain.value = mix.limiter ? 1 : 0;
  limiterBypass.gain.value = mix.limiter ? 0 : 1;
}

function distortionCurve(amount) {
  const samples = 44100;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function reverbImpulse(ctx) {
  const rate = ctx.sampleRate;
  const length = rate * 2;
  const impulse = ctx.createBuffer(2, length, rate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);
  for (let i = 0; i < length; i++) {
    const decay = Math.exp(-i / (rate * 0.5));
    left[i] = (Math.random() * 2 - 1) * decay;
    right[i] = (Math.random() * 2 - 1) * decay;
  }
  return impulse;
}

function restorePlayhead() {
  if (mix.currentTime <= 0) {
    playheadReady = true;
    return;
  }
  const place = () => {
    if (!Number.isFinite(score.duration) || score.duration <= 0) return;
    playheadReady = true;
    score.currentTime = Math.min(mix.currentTime, score.duration - 0.05);
  };
  if (score.readyState >= 1) place();
  else score.addEventListener('loadedmetadata', place, { once: true });
}

function clampParam(name, number) {
  const [min, max] = PARAM_RANGE[name];
  if (!Number.isFinite(number)) return mixDefaults[name];
  return Math.min(max, Math.max(min, number));
}

function readStoredMix() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const stored = {};
  for (const name of Object.keys(PARAM_RANGE)) {
    const number = Number(parsed[name]);
    if (Number.isFinite(number)) stored[name] = clampParam(name, number);
  }
  if (typeof parsed.mono === 'boolean') stored.mono = parsed.mono;
  if (typeof parsed.limiter === 'boolean') stored.limiter = parsed.limiter;
  const time = Number(parsed.currentTime);
  if (Number.isFinite(time) && time >= 0) stored.currentTime = time;
  return stored;
}

function persistMix() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(mix));
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = 0;
    persistMix();
  }, 500);
}

function emit(type) {
  for (const listener of listeners) listener(type);
}

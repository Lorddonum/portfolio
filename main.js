import * as THREE from 'three';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Observer } from 'gsap/observer';

gsap.registerPlugin(ScrollTrigger, Observer);
// ... existing scene setup ...

// --- SCENE SETUP ---
const canvas = document.querySelector('#webgl');
const scene = new THREE.Scene();

// Minimalist Background (Charcoal Black)
scene.background = new THREE.Color('#080808');

// Orthographic camera is often better for 2D plane shader effects
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = 2; // Close to the plane

const renderer = new THREE.WebGLRenderer({
  canvas: canvas,
  antialias: true,
  alpha: false
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// --- AUDIO SETUP (native Audio for seek support + Web Audio API for analyser) ---
const audioEl = new Audio('./groovy deep house mix session.mp3');
audioEl.loop = true;
audioEl.volume = 0.5;

// Web Audio API for analyser
let audioCtx, analyserNode, source, analyser;
let audioCtxStarted = false;

function initAudioContext() {
  if (audioCtxStarted) return;
  audioCtxStarted = true;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  source = audioCtx.createMediaElementSource(audioEl);

  // DSP Nodes
  window.eqLow = audioCtx.createBiquadFilter();
  window.eqLow.type = 'lowshelf';
  window.eqLow.frequency.value = 320;

  window.eqMid = audioCtx.createBiquadFilter();
  window.eqMid.type = 'peaking';
  window.eqMid.frequency.value = 1000;
  window.eqMid.Q.value = 0.5;

  window.eqHigh = audioCtx.createBiquadFilter();
  window.eqHigh.type = 'highshelf';
  window.eqHigh.frequency.value = 3200;

  window.filterLP = audioCtx.createBiquadFilter();
  window.filterLP.type = 'lowpass';
  window.filterLP.frequency.value = 20000;

  window.filterHP = audioCtx.createBiquadFilter();
  window.filterHP.type = 'highpass';
  window.filterHP.frequency.value = 20;

  window.distortion = audioCtx.createWaveShaper();
  function makeDistortionCurve(amount) {
    const k = amount;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = i * 2 / n_samples - 1;
      curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }
  window.distortion.curve = makeDistortionCurve(0);
  window.distortion.oversample = '4x';
  window.makeDistortionCurve = makeDistortionCurve;

  window.reverb = audioCtx.createConvolver();
  function createReverb() {
    const rate = audioCtx.sampleRate;
    const length = rate * 2.0;
    const impulse = audioCtx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);
    for (let i = 0; i < length; i++) {
      const decay = Math.exp(-i / (rate * 0.5));
      left[i] = (Math.random() * 2 - 1) * decay;
      right[i] = (Math.random() * 2 - 1) * decay;
    }
    return impulse;
  }
  window.reverb.buffer = createReverb();

  window.dryNode = audioCtx.createGain();
  window.wetNode = audioCtx.createGain();
  window.wetNode.gain.value = 0;
  window.dryNode.gain.value = 1;

  window.limiter = audioCtx.createDynamicsCompressor();
  window.limiter.threshold.value = -3;
  window.limiter.knee.value = 0;
  window.limiter.ratio.value = 20;
  window.limiter.attack.value = 0.005;
  window.limiter.release.value = 0.05;

  window.limiterBypass = audioCtx.createGain();
  window.limiterBypass.gain.value = 0; // Off by default as limiter takes over

  window.masterVol = audioCtx.createGain();
  window.masterVol.gain.value = 0.5;

  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 1024;

  // Chain: Source -> EQ -> Filters -> Distortion -> Split(Dry/Wet Reverb) -> MasterVol -> Split(Limiter/Bypass) -> Analyser -> Dest
  source.connect(window.eqLow);
  window.eqLow.connect(window.eqMid);
  window.eqMid.connect(window.eqHigh);
  window.eqHigh.connect(window.filterHP);
  window.filterHP.connect(window.filterLP);
  window.filterLP.connect(window.distortion);

  window.distortion.connect(window.dryNode);
  window.distortion.connect(window.wetNode);
  window.wetNode.connect(window.reverb);

  window.dryNode.connect(window.masterVol);
  window.reverb.connect(window.masterVol);

  window.masterVol.connect(window.limiter);
  window.masterVol.connect(window.limiterBypass);

  window.limiter.connect(analyserNode);
  window.limiterBypass.connect(analyserNode);

  analyserNode.connect(audioCtx.destination);

  // Fake analyser-compatible object to feed into shader
  analyser = {
    getAverageFrequency: () => {
      const data = new Uint8Array(analyserNode.frequencyBinCount);
      analyserNode.getByteFrequencyData(data);
      return data.reduce((a, b) => a + b, 0) / data.length;
    }
  };
}

// UI Elements
const audioToggle = document.getElementById('audio-toggle');
const audioStatusBox = document.getElementById('audio-status');
const audioIndicator = document.querySelector('.indicator');
const audioPanel = document.getElementById('audio-panel');
const playPauseBtn = document.getElementById('play-pause-btn');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const seekBarContainer = document.getElementById('seek-bar-container');
const seekBarFill = document.getElementById('seek-bar-fill');
const seekBarTrack = document.getElementById('seek-bar-track');
const seekCurrent = document.getElementById('seek-current');
const seekTotal = document.getElementById('seek-total');
const seekTime = document.querySelector('.seek-time');

let soundEnabled = false;

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function updatePlayPauseIcon() {
  if (audioEl.paused) {
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
  } else {
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
  }
}

// Sound ON/OFF toggle
audioToggle.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  initAudioContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

  if (soundEnabled) {
    audioEl.play();
    audioStatusBox.innerText = 'ON';
    audioIndicator.classList.add('active');
    audioPanel.classList.add('visible');
    seekBarContainer.classList.add('visible');
  } else {
    audioEl.pause();
    audioStatusBox.innerText = 'OFF';
    audioIndicator.classList.remove('active');
    audioPanel.classList.remove('visible');
    seekBarContainer.classList.remove('visible');
  }
  updatePlayPauseIcon();
});

// Play / Pause button
playPauseBtn.addEventListener('click', () => {
  if (audioEl.paused) {
    audioEl.play();
  } else {
    audioEl.pause();
  }
  updatePlayPauseIcon();
});

// Seekbar progress update
audioEl.addEventListener('timeupdate', () => {
  if (!audioEl.duration) return;
  const pct = (audioEl.currentTime / audioEl.duration) * 100;
  seekBarFill.style.width = pct + '%';
  seekCurrent.textContent = formatTime(audioEl.currentTime);
  seekTotal.textContent = formatTime(audioEl.duration);
});

// Click to seek
seekBarTrack.addEventListener('click', (e) => {
  const rect = seekBarTrack.getBoundingClientRect();
  const fraction = (e.clientX - rect.left) / rect.width;
  audioEl.currentTime = fraction * audioEl.duration;
});




// --- SHADERS & FLUID PLANE ---

// Dense segments for smooth EQ deformation
const geometry = new THREE.PlaneGeometry(10, 6, 300, 120);

// 8 frequency band uniforms (bass → treble)
const material = new THREE.ShaderMaterial({
  wireframe: false,
  uniforms: {
    uTime: { value: 0 },
    uBand0: { value: 0 }, // Sub-bass
    uBand1: { value: 0 }, // Bass
    uBand2: { value: 0 }, // Low-mid
    uBand3: { value: 0 }, // Mid
    uBand4: { value: 0 }, // Upper-mid
    uBand5: { value: 0 }, // Presence
    uBand6: { value: 0 }, // Brilliance
    uBand7: { value: 0 }, // Air
    uColorBase: { value: new THREE.Color('#0a0a0a') },
    uColorPeak: { value: new THREE.Color('#ededed') },
    uScrollOffset: { value: 0 },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uMouseSpeed: { value: 0.0 }
  },
  vertexShader: `
    uniform float uTime;
    uniform float uBand0, uBand1, uBand2, uBand3;
    uniform float uBand4, uBand5, uBand6, uBand7;
    uniform float uScrollOffset;
    uniform vec2 uMouse;
    uniform float uMouseSpeed;

    varying float vElevation;
    varying float vBandEnergy;

    // Simplex Noise 2D
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
      vec2 i  = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod289(i);
      vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
      m = m*m; m = m*m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
      vec3 g;
      g.x  = a0.x  * x0.x  + h.x  * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    // Smooth interpolation across 8 bands
    float getBandEnergy(float nx) {
      float t = clamp((nx + 1.0) / 2.0, 0.0, 1.0) * 7.0; // 0..7
      int i = int(floor(t));
      float f = fract(t); // 0..1 fractional position within current band
      // Smooth cubic ease for the blend
      float s = f * f * (3.0 - 2.0 * f);

      float b0 = uBand0, b1 = uBand1, b2 = uBand2, b3 = uBand3;
      float b4 = uBand4, b5 = uBand5, b6 = uBand6, b7 = uBand7;

      if      (i == 0) return mix(b0, b1, s);
      else if (i == 1) return mix(b1, b2, s);
      else if (i == 2) return mix(b2, b3, s);
      else if (i == 3) return mix(b3, b4, s);
      else if (i == 4) return mix(b4, b5, s);
      else if (i == 5) return mix(b5, b6, s);
      else             return mix(b6, b7, s);
    }

    void main() {
      vec3 pos = position;

      // Normalise X to -1..1
      float nx = pos.x / 5.0;

      // Which band drives this column?
      float bandEnergy = getBandEnergy(nx);
      float bandNorm = bandEnergy / 255.0; // 0..1

      // EQ spike — smooth noise envelope modulates the spike so columns blend organically
      float eqSpike = bandNorm * 0.9;
      // Modulate spike amplitude along Y so it rises toward front edge
      float yFade = smoothstep(-3.0, 0.5, pos.y);
      eqSpike *= yFade;

      // Soft noise underneath for organic feel — scales with energy too
      float ambientWave = snoise(vec2(pos.x * 0.5 + uTime * 0.15, pos.y * 0.5 + uTime * 0.1)) * 0.12;

      // Ripple: fast noise scaled by energy (gives the "trembling" reaction)
      float ripple = snoise(vec2(pos.x * 2.5 - uTime * 0.8, pos.y * 2.5 + uTime * 0.4)) * bandNorm * 0.35;

      // Scroll wave
      float scrollWave = snoise(vec2(pos.x * 0.4, pos.y + uScrollOffset)) * 0.08;

      // Compute interactive mouse ripple
      float distToMouse = distance(uv, uMouse);
      float mouseRipple = smoothstep(0.3, 0.0, distToMouse);
      
      // The ripple pulls the vertex up aggressively based on cursor speed
      float mouseEffect = mouseRipple * uMouseSpeed * 1.5;

      float elevation = ambientWave + eqSpike + ripple + scrollWave + mouseEffect;

      pos.z += elevation;
      pos.x *= 1.4;

      vElevation = elevation;
      vBandEnergy = bandNorm;
      
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(pos, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uColorBase;
    uniform vec3 uColorPeak;
    
    varying float vElevation;
    varying float vBandEnergy;
    varying vec2 vUv; // Receive UV from vertex shader

    void main() {
      // Base-to-highlight blend on elevation
      float t = smoothstep(-0.05, 0.7, vElevation);
      vec3 color = mix(uColorBase, uColorPeak, t);

      // Extra brightness flash on peaks
      color += uColorPeak * vBandEnergy * 0.12;

      gl_FragColor = vec4(color, 1.0);
    }
  `
});

const plane = new THREE.Mesh(geometry, material);
plane.rotation.x = -Math.PI * 0.38;
plane.rotation.z = Math.PI * 0.08;
plane.position.y = -1.2;
scene.add(plane);


// --- SCROLL ANIMATIONS & TEXT REVEAL ---
function setupScrollAnimations() {
  const sections = document.querySelectorAll('.panel');
  let currentIndex = 0;
  let isAnimating = false;

  // We must prepare the words for About first so it's ready before animation
  const paragraphs = document.querySelectorAll('.matrix-text');
  paragraphs.forEach(paragraph => {
    if (!paragraph.querySelector('.word')) {
      const childNodes = Array.from(paragraph.childNodes);
      childNodes.forEach(node => {
        if (node.nodeType === 3) {
          let words = node.nodeValue.split(' ').map(w => {
            if (w.trim() === '') return w;
            return `<span class="word">${w}</span>`;
          }).join(' ');
          let newNode = document.createElement('span');
          newNode.innerHTML = words;
          paragraph.replaceChild(newNode, node);
        } else if (node.nodeType === 1 && node.classList.contains('keyword')) {
          node.classList.add('word');
        }
      });
    }
  });

  // Prepare custom bespoke entry & exit animations
  const entryAnimations = [
    // 0: Hero
    (dir) => {
      const tl = gsap.timeline();
      tl.fromTo('.hero .eyebrow', { opacity: 0, y: dir * 20 }, { opacity: 1, y: 0, duration: 0.8, ease: "power2.out" })
        .fromTo('.hero .mask-text', { y: dir === 1 ? "100%" : "-100%" }, { y: "0%", duration: 1.2, ease: "power4.out", stagger: 0.15 }, "-=0.4")
        .fromTo('.hero .donum-btn', { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 1.5, ease: "elastic.out(1, 0.5)" }, "-=0.8")
        .fromTo('.hero .scroll-down', { opacity: 0, y: dir * 10 }, { opacity: 1, y: 0, duration: 0.8, ease: "power1.out" }, "-=1.0");
      return tl;
    },
    // 1: About
    (dir) => {
      const tl = gsap.timeline();
      tl.fromTo('#about .profile-bg-large',
        { opacity: 0, x: dir * 100, scale: 0.95 },
        { opacity: 0.7, x: 0, scale: 1, duration: 1.2, ease: "power3.out" }, 0);
      tl.fromTo('#about .section-title', { opacity: 0, y: dir * 50 }, { opacity: 1, y: 0, duration: 1, ease: "power3.out" }, 0.2);
      const keywords = document.querySelectorAll('.matrix-text .keyword.word');
      const words = document.querySelectorAll('.matrix-text .word:not(.keyword)');
      if (keywords.length) {
        tl.fromTo(keywords, { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.8, ease: "power2.out", stagger: 0.1 }, 0.2);
      }
      if (words.length) {
        const shuffledWords = Array.from(words).sort(() => 0.5 - Math.random());
        tl.fromTo(shuffledWords, { opacity: 0, y: dir * 10 }, { opacity: 1, y: 0, duration: 0.1, stagger: 0.02, ease: "none" }, 0.7);
      }
      return tl;
    },
    // 2: Experience
    (dir) => {
      const tl = gsap.timeline();
      tl.fromTo('#experience .about-label', { opacity: 0, x: dir * -50 }, { opacity: 1, x: 0, duration: 1, ease: "power3.out" });
      tl.fromTo('#experience .list-item',
        { opacity: 0, x: dir * 100, skewX: dir * -10 },
        { opacity: 1, x: 0, skewX: 0, duration: 1, stagger: 0.15, ease: "power3.out" }, 0.2);
      return tl;
    },
    // 3: Skills
    (dir) => {
      const tl = gsap.timeline();
      tl.fromTo('#skills .section-title', { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 1, ease: "back.out(1.7)" });
      tl.fromTo('#skills .stack-item',
        { opacity: 0, scale: 0.3, y: dir * 50, rotation: dir * 10 },
        { opacity: 1, scale: 1, y: 0, rotation: 0, duration: 0.8, stagger: { amount: 0.6, grid: 'auto', from: 'center' }, ease: "back.out(1.8)" }, 0.2);
      return tl;
    },
    // 4: Contact
    (dir) => {
      const tl = gsap.timeline();
      tl.fromTo('#contact .huge-text',
        { opacity: 0, y: dir * 80, filter: "blur(20px)" },
        { opacity: 1, y: 0, filter: "blur(0px)", duration: 1.5, stagger: 0.2, ease: "power4.out" });
      tl.fromTo('#contact .link-btn',
        { opacity: 0, scale: 0.8 },
        { opacity: 1, scale: 1, duration: 1, ease: "elastic.out(1, 0.5)" }, 0.6);
      return tl;
    }
  ];

  const exitAnimations = [
    // 0: Hero
    (dir) => {
      const tl = gsap.timeline();
      tl.to('.hero .eyebrow', { opacity: 0, y: dir * -20, duration: 0.6, ease: "power2.in" })
        .to('.hero .mask-text', { y: dir === 1 ? "-100%" : "100%", duration: 0.8, ease: "power3.in", stagger: 0.1 }, 0)
        .to('.hero .donum-btn', { scale: 0.5, opacity: 0, duration: 0.6, ease: "back.in(1.5)" }, 0)
        .to('.hero .scroll-down', { opacity: 0, y: dir * 10, duration: 0.4 }, 0);
      return tl;
    },
    // 1: About
    (dir) => {
      const tl = gsap.timeline();
      tl.to('#about .profile-bg-large', { opacity: 0, x: dir * -100, scale: 0.95, duration: 0.8, ease: "power3.in" }, 0);
      tl.to('#about .section-title', { opacity: 0, y: dir * -50, duration: 0.6, ease: "power3.in" }, 0);
      const keywords = document.querySelectorAll('.matrix-text .keyword.word');
      const words = document.querySelectorAll('.matrix-text .word:not(.keyword)');
      if (words.length) tl.to(words, { opacity: 0, y: dir * -10, duration: 0.4, stagger: 0.01, ease: "none" }, 0);
      if (keywords.length) tl.to(keywords, { opacity: 0, scale: 0.9, duration: 0.6, stagger: 0.05 }, 0.1);
      return tl;
    },
    // 2: Experience
    (dir) => {
      const tl = gsap.timeline();
      tl.to('#experience .list-item', { opacity: 0, x: dir * -100, skewX: dir * 10, duration: 0.6, stagger: 0.1, ease: "power3.in" })
        .to('#experience .about-label', { opacity: 0, x: dir * -50, duration: 0.6, ease: "power3.in" }, 0.2);
      return tl;
    },
    // 3: Skills
    (dir) => {
      const tl = gsap.timeline();
      tl.to('#skills .stack-item', { opacity: 0, scale: 0.3, y: dir * -50, duration: 0.6, stagger: { amount: 0.3, grid: 'auto', from: 'center' }, ease: "back.in(1.5)" })
        .to('#skills .section-title', { opacity: 0, scale: 0.8, duration: 0.6, ease: "power3.in" }, 0.2);
      return tl;
    },
    // 4: Contact
    (dir) => {
      const tl = gsap.timeline();
      tl.to('#contact .huge-text', { opacity: 0, y: dir * -80, filter: "blur(20px)", duration: 0.8, stagger: 0.1, ease: "power3.in" })
        .to('#contact .link-btn', { opacity: 0, scale: 0.8, duration: 0.6, ease: "power3.in" }, 0.2);
      return tl;
    }
  ];

  // Map 3D plane transforms to sections
  const webglStates = [
    { offset: 0.0, camY: 0, camZ: 2, rotZ: 0 },
    { offset: 1.2, camY: -0.2, camZ: 2.2, rotZ: -Math.PI * 0.05 },
    { offset: 2.4, camY: -0.4, camZ: 2.4, rotZ: -Math.PI * 0.1 },
    { offset: 3.6, camY: -0.5, camZ: 2.5, rotZ: -Math.PI * 0.15 },
    { offset: 5.0, camY: 0, camZ: 2, rotZ: 0 }
  ];

  function gotoSection(index, direction) {
    if (index < 0 || index >= sections.length || isAnimating) return;
    isAnimating = true;

    const currentSection = sections[currentIndex];
    const nextSection = sections[index];

    // Hide next section immediately to prevent premature flash
    gsap.set(nextSection, { autoAlpha: 0, zIndex: 30 });
    gsap.set(currentSection, { zIndex: 20 });

    // Add active class (CSS opacity/visibility gets instantly overridden by the inline autoAlpha above)
    nextSection.classList.add('active');

    // Orchestrate cross-fade / slide
    const tl = gsap.timeline({
      onComplete: () => {
        currentSection.classList.remove('active');
        // Clean inline styles so CSS drives visibility again
        gsap.set(currentSection, { clearProps: "opacity,visibility,zIndex" });
        gsap.set(nextSection, { clearProps: "zIndex" });
        isAnimating = false;
        currentIndex = index;
      }
    });

    // 1. Exit current elements
    if (exitAnimations[currentIndex]) {
      tl.add(exitAnimations[currentIndex](direction), 0);
    }

    // Fade out current section completely shortly before next section appears
    tl.to(currentSection, { autoAlpha: 0, duration: 0.4 }, 0.4);

    // 2. 3D background shift
    const next3D = webglStates[index] || webglStates[0];
    tl.to(material.uniforms.uScrollOffset, { value: next3D.offset, duration: 1.2, ease: "power2.inOut" }, 0.2);
    tl.to(camera.position, { y: next3D.camY, z: next3D.camZ, duration: 1.2, ease: "power2.inOut" }, 0.2);
    tl.to(plane.rotation, { z: next3D.rotZ, duration: 1.2, ease: "power2.inOut" }, 0.2);

    // 3. Show next container precisely at 0.8s
    tl.set(nextSection, { autoAlpha: 1 }, 0.8);

    // 4. Entry next elements
    if (entryAnimations[index]) {
      tl.add(entryAnimations[index](direction), 0.8);
    }
  }

  // Play hero entry immediately
  entryAnimations[0](1);

  // Create event watcher
  Observer.create({
    type: "wheel,touch,pointer",
    wheelSpeed: -1,
    onDown: () => {
      // scroll up / previous
      if (!isAnimating) gotoSection(currentIndex - 1, -1);
    },
    onUp: () => {
      // scroll down / next
      if (!isAnimating) gotoSection(currentIndex + 1, 1);
    },
    tolerance: 50, // Requires a solid swipe/scroll to trigger
    preventDefault: true
  });
}

// Ensure GSAP runs properly on init
setTimeout(() => {
  setupScrollAnimations();
}, 200);


// --- ANIMATION BLENDING & RENDER LOOP ---
const clock = new THREE.Clock();

// Mouse interaction tracking for tiny reactive displacement
let mouseX = 0;
let mouseY = 0;
let targetX = 0;
let targetY = 0;
const windowHalfX = window.innerWidth / 2;
const windowHalfY = window.innerHeight / 2;

// Pre-allocate FFT buffer — resized once analyserNode is ready
let fftData = new Uint8Array(512);
const bands = new Float32Array(8);

// --- MOUSE TRACKING & RAYCASTING ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let targetMouseSpeed = 0;
let lastMousePos = new THREE.Vector2();

window.addEventListener('mousemove', (event) => {
  // Normalize screen coordinates
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Calculate mouse speed for intensity
  const tempMouse = new THREE.Vector2(event.clientX, event.clientY);
  const dist = tempMouse.distanceTo(lastMousePos);
  targetMouseSpeed = Math.min(dist * 0.02, 1.0); // Clamp speed
  lastMousePos.copy(tempMouse);

  // Cast ray to intersect with our plane
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(plane); // Changed 'mesh' to 'plane'

  if (intersects.length > 0) {
    // Pass the UV coordinate intersection to the shader
    material.uniforms.uMouse.value.copy(intersects[0].uv);
  }
});


// --- ANIMATION LOOP ---
let previousTime = 0;

const animate = () => {
  requestAnimationFrame(animate);
  const elapsedTime = clock.getElapsedTime();
  const deltaTime = elapsedTime - previousTime;
  previousTime = elapsedTime;

  // Decay mouse speed back to zero automatically
  targetMouseSpeed *= 0.95;
  material.uniforms.uMouseSpeed.value += (targetMouseSpeed - material.uniforms.uMouseSpeed.value) * 0.1;

  // Mouse Parallax effect
  targetX = mouseX * 0.0005;
  targetY = mouseY * 0.0005;

  // Smoothly move camera
  camera.position.x += (targetX - camera.position.x) * 0.05;
  camera.position.y += (-targetY - camera.position.y) * 0.05;

  // Update Shader Uniforms
  material.uniforms.uTime.value = elapsedTime;

  // Handle Audio Reactivity — 8 frequency bands
  if (analyserNode && !audioEl.paused) {
    analyserNode.getByteFrequencyData(fftData);
    const bandSize = Math.floor(fftData.length / 8);

    // Average each chunk of bins into one band value
    for (let b = 0; b < 8; b++) {
      const start = b * bandSize;
      let sum = 0;
      for (let j = start; j < start + bandSize; j++) sum += fftData[j];
      bands[b] = sum / bandSize;
    }

    // Smooth-lerp into uniforms — lower = smoother/slower reaction
    const lerp = 0.09;
    material.uniforms.uBand0.value += (bands[0] - material.uniforms.uBand0.value) * lerp;
    material.uniforms.uBand1.value += (bands[1] - material.uniforms.uBand1.value) * lerp;
    material.uniforms.uBand2.value += (bands[2] - material.uniforms.uBand2.value) * lerp;
    material.uniforms.uBand3.value += (bands[3] - material.uniforms.uBand3.value) * lerp;
    material.uniforms.uBand4.value += (bands[4] - material.uniforms.uBand4.value) * lerp;
    material.uniforms.uBand5.value += (bands[5] - material.uniforms.uBand5.value) * lerp;
    material.uniforms.uBand6.value += (bands[6] - material.uniforms.uBand6.value) * lerp;
    material.uniforms.uBand7.value += (bands[7] - material.uniforms.uBand7.value) * lerp;
  } else {
    // Decay bands back to zero if audio is off
    const decay = 0.04;
    ['uBand0', 'uBand1', 'uBand2', 'uBand3', 'uBand4', 'uBand5', 'uBand6', 'uBand7'].forEach(u => {
      material.uniforms[u].value += (0 - material.uniforms[u].value) * decay;
    });
  }

  renderer.render(scene, camera);
}

animate();

// --- RESIZE HANDLER ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- DONUM THEME TOGGLE ---
const donumBtn = document.getElementById('donum-btn');
let isRisoTheme = false;

const MONO_BASE = new THREE.Color('#0a0a0a');
const MONO_PEAK = new THREE.Color('#ededed');
const RISO_BASE = new THREE.Color('#0d001a');
const RISO_PEAK = new THREE.Color('#ff2d78');

donumBtn.addEventListener('click', () => {
  isRisoTheme = !isRisoTheme;
  document.body.classList.toggle('riso-theme', isRisoTheme);

  const targetBase = isRisoTheme ? RISO_BASE : MONO_BASE;
  const targetPeak = isRisoTheme ? RISO_PEAK : MONO_PEAK;

  // GSAP tween the shader colors smoothly over 0.8s
  gsap.to(material.uniforms.uColorBase.value, {
    r: targetBase.r, g: targetBase.g, b: targetBase.b,
    duration: 0.8, ease: 'power2.inOut'
  });
  gsap.to(material.uniforms.uColorPeak.value, {
    r: targetPeak.r, g: targetPeak.g, b: targetPeak.b,
    duration: 0.8, ease: 'power2.inOut'
  });

  // Also shift the scene background
  gsap.to(scene.background, {
    r: isRisoTheme ? 0.05 : 0.03,
    g: isRisoTheme ? 0 : 0.03,
    b: isRisoTheme ? 0.1 : 0.03,
    duration: 0.8, ease: 'power2.inOut'
  });
});

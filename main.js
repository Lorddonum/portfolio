import * as THREE from 'three';
import { gsap } from 'gsap';
import Observer from 'gsap/Observer';
import {
  toggleSession,
  togglePlayback,
  seekToFraction,
  bindSeekKeys,
  subscribe,
  isSessionOpen,
  isPlaying,
  playbackTime,
  getMix,
  copyFrequency,
  FREQUENCY_BINS,
} from './audioEngine.js';
import { openMixVisuals, closeMixVisuals } from './mix.js';

gsap.registerPlugin(Observer);

const canvas = document.querySelector('#webgl');
const scene = new THREE.Scene();

scene.background = new THREE.Color('#080808');

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = 2;
const cameraRig = { x: 0, y: 0, z: 2 };

const renderer = new THREE.WebGLRenderer({
  canvas: canvas,
  antialias: true,
  alpha: false
});

function applyRendererScale() {
  const full = Math.min(window.devicePixelRatio || 1, 2);
  const ratio = document.body.classList.contains('studio-open') ? 1 : full;
  renderer.setPixelRatio(ratio);
  renderer.setSize(window.innerWidth, window.innerHeight);
}

applyRendererScale();

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

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

function renderTransport() {
  const open = isSessionOpen();
  const playing = isPlaying();
  audioStatusBox.textContent = open ? 'ON' : 'OFF';
  audioIndicator.classList.toggle('active', open);
  audioPanel.classList.toggle('visible', open);
  seekBarContainer.classList.toggle('visible', open);
  playIcon.style.display = playing ? 'none' : 'block';
  pauseIcon.style.display = playing ? 'block' : 'none';
}

function renderSeek() {
  const { current, duration } = playbackTime();
  if (!duration) return;
  seekBarFill.style.width = `${(current / duration) * 100}%`;
  seekCurrent.textContent = formatTime(current);
  seekTotal.textContent = formatTime(duration);
  const fraction = current / duration;
  seekBarTrack.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  seekBarTrack.setAttribute('aria-valuetext', formatTime(current));
}

bindSeekKeys(seekBarTrack);

subscribe((type) => {
  if (type === 'transport') renderTransport();
  if (type === 'time') renderSeek();
});

audioToggle.addEventListener('click', () => {
  toggleSession();
});

playPauseBtn.addEventListener('click', () => {
  togglePlayback();
});

seekBarTrack.addEventListener('click', (event) => {
  const rect = seekBarTrack.getBoundingClientRect();
  seekToFraction((event.clientX - rect.left) / rect.width);
});

const phoneQuery = window.matchMedia('(max-width: 768px)');

function surfaceSegments() {
  if (phoneQuery.matches) return [100, 40];
  return [300, 120];
}

function createSurface() {
  const [across, down] = surfaceSegments();
  return new THREE.PlaneGeometry(10, 6, across, down);
}

let geometry = createSurface();

const material = new THREE.ShaderMaterial({
  wireframe: false,
  side: THREE.DoubleSide,
  uniforms: {
    uTime: { value: 0 },
    uBand0: { value: 0 },
    uBand1: { value: 0 },
    uBand2: { value: 0 },
    uBand3: { value: 0 },
    uBand4: { value: 0 },
    uBand5: { value: 0 },
    uBand6: { value: 0 },
    uBand7: { value: 0 },
    uColorBase: { value: new THREE.Color('#0a0a0a') },
    uColorPeak: { value: new THREE.Color('#ededed') },
    uScrollOffset: { value: 0 },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uMouseSpeed: { value: 0.0 },
    uBend: { value: 0 },
    uSpin: { value: 0 },
    uDrive: { value: 0 },
    uReverb: { value: 0 }
  },
  vertexShader: `
    uniform float uTime;
    uniform float uBand0, uBand1, uBand2, uBand3;
    uniform float uBand4, uBand5, uBand6, uBand7;
    uniform float uScrollOffset;
    uniform vec2 uMouse;
    uniform float uMouseSpeed;
    uniform float uBend;
    uniform float uSpin;
    uniform float uDrive;
    uniform float uReverb;

    varying float vElevation;
    varying float vBandEnergy;
    varying vec3 vWorldPos;
    varying vec3 vTubeNormal;
    varying float vSeam;

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

    float getBandEnergy(float nx) {
      float t = clamp((nx + 1.0) / 2.0, 0.0, 1.0) * 7.0;
      int i = int(floor(t));
      float f = fract(t);

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

      float nx = pos.x / 5.0;

      float bandEnergy = getBandEnergy(nx);
      float bandNorm = bandEnergy / 255.0;

      float eqSpike = bandNorm * 0.9;

      float yFade = smoothstep(-3.0, 0.5, pos.y);
      eqSpike *= yFade;

      float ambientWave = snoise(vec2(pos.x * 0.5 + uTime * 0.15, pos.y * 0.5 + uTime * 0.1)) * 0.12;

      float ripple = snoise(vec2(pos.x * 2.5 - uTime * 0.8, pos.y * 2.5 + uTime * 0.4)) * bandNorm * 0.35;

      float scrollWave = snoise(vec2(pos.x * 0.4, pos.y + uScrollOffset)) * 0.08;

      float distToMouse = distance(uv, uMouse);
      float mouseRipple = smoothstep(0.3, 0.0, distToMouse);
      

      float mouseEffect = mouseRipple * uMouseSpeed * 1.5;

      float fine = snoise(vec2(pos.x * 2.6 + uTime * 0.04, pos.y * 3.1 - uTime * 0.03)) * 0.018;
      float grit = snoise(vec2(pos.x * 7.5 + uTime * 1.6, pos.y * 5.5 - uTime * 0.9)) * uDrive * 0.28;
      float tail = snoise(vec2(pos.x * 0.28 - uTime * 0.07, pos.y * 0.22 + uTime * 0.04)) * uReverb * 0.34;
      float elevation = ambientWave + eqSpike + ripple + scrollWave + mouseEffect + fine + grit + tail;
      float seam = smoothstep(0.88, 0.97, abs(nx));
      float closedEdge = snoise(vec2(2.5 + uTime * 0.15, pos.y * 0.5 + uTime * 0.1)) * 0.12
        + snoise(vec2(2.0, pos.y + uScrollOffset)) * 0.08;
      float roundElevation = mix(elevation, closedEdge, seam);

      vec3 flatPos = vec3(position.x * 1.4, position.y, elevation);
      vec3 flatWorld = (modelMatrix * vec4(flatPos, 1.0)).xyz;
      vec3 worldPos = flatWorld;
      vec3 tubeNormal = vec3(0.0, 0.0, 1.0);
      float t = clamp(uBend, 0.0, 1.0);

      if (t > 0.0008) {
        vec3 spine = (modelMatrix * vec4(0.0, position.y, elevation, 1.0)).xyz;
        vec2 lateral = flatWorld.xy - spine.xy;
        float endR = 2.85 - roundElevation * 0.85;
        float openR = 7.0 / max(t * 3.14159265, 1e-3);
        float radius = mix(openR, endR, t);
        float span = mix(1.0, 1.008, t);
        float wrapped = nx * 3.14159265 * span + uSpin;
        float th = mix(lateral.x / max(radius, 0.001), wrapped, t);
        vec2 spineXY = mix(spine.xy, cameraPosition.xy + vec2(0.0, -endR), t);
        float along = (position.y + 3.0) / 6.0;
        float endZ = cameraPosition.z - mix(0.7, 8.0, along);
        worldPos.xy = spineXY + vec2(
          sin(th) * radius,
          lateral.y * (1.0 - t) + (1.0 - cos(th)) * radius
        );
        worldPos.z = mix(flatWorld.z, endZ, t);
        tubeNormal = vec3(-sin(th), cos(th), 0.0);
      }

      vElevation = mix(elevation, roundElevation, t) * mix(1.0, 1.35, t);
      vBandEnergy = mix(bandNorm, 0.0, seam * t);
      vWorldPos = worldPos;
      vTubeNormal = tubeNormal;
      vSeam = seam;

      gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uColorBase;
    uniform vec3 uColorPeak;
    uniform float uBend;
    uniform float uDrive;
    uniform float uReverb;
    
    varying float vElevation;
    varying float vBandEnergy;
    varying vec3 vWorldPos;
    varying vec3 vTubeNormal;
    varying float vSeam;

    void main() {
      vec3 viewDir = normalize(cameraPosition - vWorldPos);
      vec3 geom = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
      if (dot(geom, viewDir) < 0.0) geom = -geom;

      vec3 radial = normalize(vTubeNormal);
      if (dot(radial, viewDir) < 0.0) radial = -radial;

      float curl = smoothstep(0.35, 0.9, uBend);
      vec3 normal = normalize(mix(geom, radial, curl));
      vec3 lightDir = normalize(vec3(-0.35, 0.82, 0.42));
      float key = dot(normal, lightDir);
      float side = smoothstep(-0.2, 0.9, key);
      float around = clamp(key * 0.32 + 0.64, 0.0, 1.0);
      float form = mix(side, around, curl);
      float crest = smoothstep(-0.02, 0.55, vElevation);
      float ink = crest * mix(0.28, 1.0, form);
      float spec = pow(max(dot(normal, normalize(lightDir + viewDir)), 0.0), 48.0);
      spec *= 1.0 - vSeam * curl;

      vec3 color = mix(uColorBase, uColorPeak, clamp(ink, 0.0, 1.0));
      color += uColorPeak * spec * crest * mix(0.18, 0.08, curl);
      color += uColorPeak * vBandEnergy * 0.1;
      color += uColorPeak * uDrive * crest * 0.45;
      color = mix(color, uColorPeak, uReverb * (0.18 + crest * 0.22) * 0.22);

      float fog = smoothstep(5.5, 13.0, length(cameraPosition - vWorldPos));
      color = mix(color, uColorBase, fog * mix(0.65, 0.35, curl));

      gl_FragColor = vec4(color, 1.0);
    }
  `
});

const plane = new THREE.Mesh(geometry, material);
const pointerPlane = new THREE.Mesh(new THREE.PlaneGeometry(10, 6, 1, 1));

function fitSurface() {
  const [across, down] = surfaceSegments();
  if (geometry.parameters.widthSegments === across && geometry.parameters.heightSegments === down) return;
  const next = createSurface();
  geometry.dispose();
  geometry = next;
  plane.geometry = geometry;
}

function matchPointerPlane() {
  pointerPlane.position.copy(plane.position);
  pointerPlane.rotation.copy(plane.rotation);
  pointerPlane.scale.copy(plane.scale);
  pointerPlane.updateMatrixWorld();
}
plane.rotation.x = -Math.PI * 0.38;
plane.rotation.z = Math.PI * 0.08;
plane.position.y = -1.2;
scene.add(plane);

function setupScrollAnimations() {
  const sections = document.querySelectorAll('.panel');
  let currentIndex = 0;
  let isAnimating = false;

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

  const entryAnimations = [

    (dir) => {
      const tl = gsap.timeline();
      tl.fromTo('.hero .eyebrow', { opacity: 0, y: dir * 20 }, { opacity: 1, y: 0, duration: 0.8, ease: "power2.out" })
        .fromTo('.hero .mask-text', { y: dir === 1 ? "100%" : "-100%" }, { y: "0%", duration: 1.2, ease: "power4.out", stagger: 0.15 }, "-=0.4")
        .fromTo('.hero .donum-btn', { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 1.5, ease: "elastic.out(1, 0.5)" }, "-=0.8")
        .fromTo('.hero .scroll-down', { opacity: 0, y: dir * 10 }, { opacity: 1, y: 0, duration: 0.8, ease: "power1.out" }, "-=1.0");
      return tl;
    },

    (dir) => {
      const tl = gsap.timeline();
      tl.fromTo('#about .profile-bg-large',
        { opacity: 0, x: dir * 100, scale: 0.95 },
        { opacity: 0.7, x: 0, scale: 1, duration: 1.2, ease: "power3.out" }, 0);
      tl.fromTo('#about .about-label', { opacity: 0, y: dir * 30 }, { opacity: 1, y: 0, duration: 0.8, ease: "power3.out" }, 0.1);
      tl.fromTo('#about .editorial-headline', { opacity: 0, y: dir * 50 }, { opacity: 1, y: 0, duration: 1, ease: "power3.out" }, 0.2);
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

    (dir) => {
      const tl = gsap.timeline();
      tl.fromTo('#experience .about-label', { opacity: 0, x: dir * -50 }, { opacity: 1, x: 0, duration: 1, ease: "power3.out" });
      tl.fromTo('#experience .list-item',
        { opacity: 0, x: dir * 100, skewX: dir * -10 },
        { opacity: 1, x: 0, skewX: 0, duration: 1, stagger: 0.15, ease: "power3.out" }, 0.2);
      tl.set('#experience .list-item', { clearProps: 'transform' });
      return tl;
    },

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

    (dir) => {
      const tl = gsap.timeline();
      tl.to('.hero .eyebrow', { opacity: 0, y: dir * -20, duration: 0.6, ease: "power2.in" })
        .to('.hero .mask-text', { y: dir === 1 ? "-100%" : "100%", duration: 0.8, ease: "power3.in", stagger: 0.1 }, 0)
        .to('.hero .donum-btn', { scale: 0.5, opacity: 0, duration: 0.6, ease: "back.in(1.5)" }, 0)
        .to('.hero .scroll-down', { opacity: 0, y: dir * 10, duration: 0.4 }, 0);
      return tl;
    },

    (dir) => {
      const tl = gsap.timeline();
      tl.to('#about .profile-bg-large', { opacity: 0, x: dir * -100, scale: 0.95, duration: 0.8, ease: "power3.in" }, 0);
      tl.to('#about .editorial-headline', { opacity: 0, y: dir * -40, duration: 0.5, ease: "power3.in" }, 0);
      tl.to('#about .about-label', { opacity: 0, y: dir * -20, duration: 0.4, ease: "power3.in" }, 0);
      const keywords = document.querySelectorAll('.matrix-text .keyword.word');
      const words = document.querySelectorAll('.matrix-text .word:not(.keyword)');
      if (words.length) tl.to(words, { opacity: 0, y: dir * -10, duration: 0.4, stagger: 0.01, ease: "none" }, 0);
      if (keywords.length) tl.to(keywords, { opacity: 0, scale: 0.9, duration: 0.6, stagger: 0.05 }, 0.1);
      return tl;
    },

    (dir) => {
      const tl = gsap.timeline();
      tl.to('#experience .list-item', { opacity: 0, x: dir * -100, skewX: dir * 10, duration: 0.6, stagger: 0.1, ease: "power3.in" })
        .to('#experience .about-label', { opacity: 0, x: dir * -50, duration: 0.6, ease: "power3.in" }, 0.2);
      return tl;
    },

    (dir) => {
      const tl = gsap.timeline();
      tl.to('#contact .huge-text', { opacity: 0, y: dir * -80, filter: "blur(20px)", duration: 0.8, stagger: 0.1, ease: "power3.in" })
        .to('#contact .link-btn', { opacity: 0, scale: 0.8, duration: 0.6, ease: "power3.in" }, 0.2);
      return tl;
    }
  ];

  const webglStates = [
    { offset: 0.0, camY: 0, camZ: 2, rotZ: 0 },
    { offset: 1.2, camY: -0.2, camZ: 2.2, rotZ: -Math.PI * 0.05 },
    { offset: 2.4, camY: -0.4, camZ: 2.4, rotZ: -Math.PI * 0.1 },
    { offset: 5.0, camY: 0, camZ: 2, rotZ: 0 }
  ];

  function gotoSection(index, direction) {
    if (index === currentIndex || index < 0 || index >= sections.length || isAnimating) return;
    isAnimating = true;
    markSection(index);

    const currentSection = sections[currentIndex];
    const nextSection = sections[index];
    nextSection.scrollTop = direction > 0 ? 0 : nextSection.scrollHeight;

    gsap.set(nextSection, { autoAlpha: 0, zIndex: 30 });
    gsap.set(currentSection, { zIndex: 20 });

    nextSection.classList.add('active');

    const tl = gsap.timeline({
      onComplete: () => {
        currentSection.classList.remove('active');

        gsap.set(currentSection, { clearProps: "opacity,visibility,zIndex" });
        gsap.set(nextSection, { clearProps: "zIndex" });
        isAnimating = false;
        currentIndex = index;
      }
    });

    if (exitAnimations[currentIndex]) {
      tl.add(exitAnimations[currentIndex](direction), 0);
    }

    tl.to(currentSection, { autoAlpha: 0, duration: 0.4 }, 0.4);

    const next3D = webglStates[index] || webglStates[0];
    tl.to(material.uniforms.uScrollOffset, { value: next3D.offset, duration: 1.2, ease: "power2.inOut" }, 0.2);
    tl.to(cameraRig, { y: next3D.camY, z: next3D.camZ, duration: 1.2, ease: "power2.inOut" }, 0.2);
    tl.to(plane.rotation, { z: next3D.rotZ, duration: 1.2, ease: "power2.inOut" }, 0.2);

    tl.set(nextSection, { autoAlpha: 1 }, 0.8);

    if (entryAnimations[index]) {
      tl.add(entryAnimations[index](direction), 0.8);
    }
  }

  const sectionButtons = document.querySelectorAll('.section-nav button');

  function markSection(index) {
    sectionButtons.forEach((button, buttonIndex) => {
      if (buttonIndex === index) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
  }

  function moveSection(direction) {
    if (sectionScrollLocked || isAnimating) return;
    if (panelCanConsume(direction)) return;
    gotoSection(currentIndex + direction, direction);
  }

  function panelCanConsume(direction) {
    const panel = document.querySelector('.panel.active');
    if (!panel) return false;
    const max = panel.scrollHeight - panel.clientHeight;
    if (max <= 1) return false;
    if (direction > 0) return panel.scrollTop < max - 1;
    return panel.scrollTop > 1;
  }

  window.addEventListener('wheel', (event) => {
    if (sectionScrollLocked) return;
    const direction = event.deltaY > 0 ? 1 : -1;
    if (panelCanConsume(direction)) return;
    event.preventDefault();
  }, { passive: false });

  entryAnimations[0](1);

  Observer.create({
    type: "wheel,touch,pointer",
    wheelSpeed: -1,
    onDown: () => moveSection(-1),
    onUp: () => moveSection(1),
    tolerance: 50,
    preventDefault: false
  });

  sectionButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index);
      gotoSection(index, index > currentIndex ? 1 : -1);
    });
  });

  window.addEventListener('keydown', (event) => {
    if (sectionScrollLocked) return;
    if (event.target.closest('input, textarea, select, [role="slider"], .knob-container')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'ArrowDown' || event.key === 'PageDown') {
      event.preventDefault();
      moveSection(1);
    } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
      event.preventDefault();
      moveSection(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      gotoSection(0, -1);
    } else if (event.key === 'End') {
      event.preventDefault();
      gotoSection(sections.length - 1, 1);
    }
  });
}

let sectionScrollLocked = false;

setTimeout(() => {
  setupScrollAnimations();
}, 200);

const clock = new THREE.Clock();
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let mouseOffsetX = 0;
let mouseOffsetY = 0;
let windowHalfX = window.innerWidth / 2;
let windowHalfY = window.innerHeight / 2;
const parallax = { x: 0, y: 0 };

const frequencyBins = new Uint8Array(FREQUENCY_BINS);
const bands = new Float32Array(8);

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let targetMouseSpeed = 0;
let lastMousePos = new THREE.Vector2();

window.addEventListener('mousemove', (event) => {

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  mouseOffsetX = event.clientX - windowHalfX;
  mouseOffsetY = event.clientY - windowHalfY;

  const tempMouse = new THREE.Vector2(event.clientX, event.clientY);
  const dist = tempMouse.distanceTo(lastMousePos);
  targetMouseSpeed = Math.min(dist * 0.02, 1.0);
  lastMousePos.copy(tempMouse);

  raycaster.setFromCamera(mouse, camera);
  matchPointerPlane();
  const intersects = raycaster.intersectObject(pointerPlane);

  if (intersects.length > 0) {

    material.uniforms.uMouse.value.copy(intersects[0].uv);
  }
});

const animate = () => {
  requestAnimationFrame(animate);
  const deltaTime = Math.min(clock.getDelta(), 0.05);
  if (document.hidden) return;

  targetMouseSpeed *= 0.95;
  material.uniforms.uMouseSpeed.value += (targetMouseSpeed - material.uniforms.uMouseSpeed.value) * 0.1;

  parallax.x += (mouseOffsetX * 0.0005 - parallax.x) * 0.05;
  parallax.y += (mouseOffsetY * 0.0005 - parallax.y) * 0.05;
  camera.position.x = cameraRig.x + parallax.x;
  camera.position.y = cameraRig.y - parallax.y;
  camera.position.z = cameraRig.z;

  const motion = getMix();
  const pace = reduceMotion.matches ? 1 : motion.tapeSpeed;
  material.uniforms.uTime.value += deltaTime * pace;
  material.uniforms.uDrive.value += (motion.drive / 20 - material.uniforms.uDrive.value) * 0.12;
  material.uniforms.uReverb.value += (motion.reverb - material.uniforms.uReverb.value) * 0.12;
  const bend = material.uniforms.uBend.value;
  if (bend > 0.98 && !reduceMotion.matches) {
    material.uniforms.uSpin.value = (material.uniforms.uSpin.value + deltaTime * 0.31 * pace) % (Math.PI * 2);
  } else if (bend < 0.02) {
    material.uniforms.uSpin.value = 0;
  }

  if (isPlaying() && copyFrequency(frequencyBins)) {
    const bandSize = Math.floor(frequencyBins.length / 8);

    for (let b = 0; b < 8; b++) {
      const start = b * bandSize;
      let sum = 0;
      for (let j = start; j < start + bandSize; j++) sum += frequencyBins[j];
      bands[b] = sum / bandSize;
    }

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
    const decay = 0.04;
    ['uBand0', 'uBand1', 'uBand2', 'uBand3', 'uBand4', 'uBand5', 'uBand6', 'uBand7'].forEach(u => {
      material.uniforms[u].value += (0 - material.uniforms[u].value) * decay;
    });
  }

  renderer.render(scene, camera);
  drawContactSpectrum();
}

const contactWord = document.getElementById('contact-getin');
const contactLabel = document.getElementById('contact-getin-label');
const contactSpectrum = document.getElementById('contact-spectrum');
const contactSpectrumCtx = contactSpectrum.getContext('2d');
const contactBins = new Uint8Array(FREQUENCY_BINS);

let contactLayout = null;

function applyContactFont(ctx, font, letterSpacing) {
  ctx.font = font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = letterSpacing;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function fitContactSpectrum(width, height) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.floor(width * ratio);
  const pixelHeight = Math.floor(height * ratio);
  if (contactSpectrum.width === pixelWidth && contactSpectrum.height === pixelHeight) return;
  contactSpectrum.width = pixelWidth;
  contactSpectrum.height = pixelHeight;
}

function contactInkBand(ctx, text, height) {
  const metrics = ctx.measureText(text);
  const baseline = (height + metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  return {
    baseline,
    top: baseline - metrics.actualBoundingBoxAscent,
    bottom: baseline + metrics.actualBoundingBoxDescent
  };
}

let contactPeak = 0.12;
let contactLevels = new Float32Array(0);

function contactBandPeak(index, count) {
  const last = contactBins.length - 1;
  const position = count <= 1 ? 0 : index / (count - 1);
  const center = Math.round(2 * Math.pow(last / 2, position));
  const reach = Math.max(1, Math.round(center * 0.06));
  const from = Math.max(0, center - reach);
  const to = Math.min(last, center + reach);
  let peak = 0;
  for (let bin = from; bin <= to; bin += 1) {
    if (contactBins[bin] > peak) peak = contactBins[bin];
  }
  return peak / 255;
}

function readContactLevels(count) {
  if (contactLevels.length !== count) contactLevels = new Float32Array(count);
  let framePeak = 0.12;
  for (let i = 0; i < count; i += 1) {
    const level = contactBandPeak(i, count);
    contactLevels[i] = level;
    if (level > framePeak) framePeak = level;
  }
  contactPeak = Math.max(framePeak, contactPeak * 0.86);
}

function paintContactBars(ctx, width, inkTop, inkBottom) {
  const span = Math.max(1, inkBottom - inkTop);
  const barWidth = 3;
  const gap = 2;
  const barCount = Math.max(1, Math.floor(width / (barWidth + gap)));
  const floor = span * 0.08;
  const travel = span - floor;
  readContactLevels(barCount);
  for (let i = 0; i < barCount; i += 1) {
    const shaped = Math.pow(contactLevels[i] / contactPeak, 0.55);
    const barHeight = floor + shaped * travel;
    const x = i * (barWidth + gap);
    const y = inkBottom - barHeight;
    ctx.fillStyle = `hsla(${(i / barCount) * 60 + 300}, 100%, 60%, 0.95)`;
    ctx.fillRect(x, y, barWidth, barHeight);
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, Math.max(inkTop, y - 2), barWidth, 1);
  }
}

function fillContactWord(ctx, box, baseline) {
  ctx.fillStyle = '#ededed';
  ctx.fillText(box.text, 0, baseline);
}

function placeContactCanvas(host, ink) {
  contactSpectrum.style.left = `${ink.left - host.left}px`;
  contactSpectrum.style.top = `${ink.top - host.top}px`;
  contactSpectrum.style.width = `${ink.width}px`;
  contactSpectrum.style.height = `${ink.height}px`;
}

function measureContact() {
  const style = getComputedStyle(contactLabel);
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const letterSpacing = style.letterSpacing;
  const host = contactWord.getBoundingClientRect();
  const ink = contactLabel.getBoundingClientRect();
  if (ink.width < 2 || ink.height < 2) return;
  const text = contactLabel.textContent.toUpperCase();
  placeContactCanvas(host, ink);
  fitContactSpectrum(ink.width, ink.height);
  const ctx = contactSpectrumCtx;
  ctx.setTransform(contactSpectrum.width / ink.width, 0, 0, contactSpectrum.height / ink.height, 0, 0);
  applyContactFont(ctx, font, letterSpacing);
  contactLayout = {
    text,
    width: ink.width,
    height: ink.height,
    font,
    letterSpacing,
    band: contactInkBand(ctx, text, ink.height)
  };
}

function drawContactSpectrum() {
  if (!contactLayout) return;
  if (!document.getElementById('contact').classList.contains('active')) return;
  if (!(isPlaying() && copyFrequency(contactBins))) contactBins.fill(0);
  const { width, height, text, font, letterSpacing, band } = contactLayout;
  const ctx = contactSpectrumCtx;
  ctx.setTransform(contactSpectrum.width / width, 0, 0, contactSpectrum.height / height, 0, 0);
  ctx.clearRect(0, 0, width, height);
  applyContactFont(ctx, font, letterSpacing);
  fillContactWord(ctx, { text }, band.baseline);
  ctx.globalCompositeOperation = 'source-atop';
  paintContactBars(ctx, width, band.top, band.bottom);
  ctx.globalCompositeOperation = 'source-over';
}

new ResizeObserver(measureContact).observe(contactLabel);
document.fonts.ready.then(measureContact);

animate();

window.addEventListener('resize', () => {
  windowHalfX = window.innerWidth / 2;
  windowHalfY = window.innerHeight / 2;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  applyRendererScale();
  fitSurface();
  measureContact();
});

phoneQuery.addEventListener('change', fitSurface);

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

  gsap.to(material.uniforms.uColorBase.value, {
    r: targetBase.r, g: targetBase.g, b: targetBase.b,
    duration: 0.8, ease: 'power2.inOut'
  });
  gsap.to(material.uniforms.uColorPeak.value, {
    r: targetPeak.r, g: targetPeak.g, b: targetPeak.b,
    duration: 0.8, ease: 'power2.inOut'
  });

  gsap.to(scene.background, {
    r: isRisoTheme ? 0.05 : 0.03,
    g: isRisoTheme ? 0 : 0.03,
    b: isRisoTheme ? 0.1 : 0.03,
    duration: 0.8, ease: 'power2.inOut'
  });
});

const mixStudioToggle = document.getElementById('mix-studio-toggle');
const mixClose = document.getElementById('mix-close');
const mixView = document.getElementById('mix-view');
let studioTimeline = null;
let splitClone = null;

function clearSplit() {
  const panel = document.querySelector('.panel.active');
  const content = panel && panel.querySelector('.content');
  const scrollMark = panel && panel.querySelector('.scroll-down');
  const moving = '.section-nav, .header, #experience .about-label, #experience .list-item, #about .about-label, #about .editorial-headline, #about .editorial-body-spacious, #about .profile-bg-large, #home .huge-text, #home .studio-letter, #donum-btn, #home .eyebrow';
  gsap.killTweensOf([content, splitClone, scrollMark].filter(Boolean));
  gsap.killTweensOf(moving);
  if (content) {
    content.style.clipPath = '';
    content.style.transform = '';
  }
  if (splitClone) {
    splitClone.remove();
    splitClone = null;
  }
  if (content) gsap.set(content, { clearProps: 'transform,clipPath,opacity,visibility' });
  if (scrollMark) gsap.set(scrollMark, { clearProps: 'transform,opacity,visibility' });
  gsap.set(moving, { clearProps: 'transform,opacity,visibility' });
  document.getElementById('experience').classList.remove('studio-exit');
  const donum = document.getElementById('donum-btn');
  if (donum) donum.style.animation = '';
}

const planeRestTilt = -Math.PI * 0.38;
const planeRestY = -1.2;

function bendPlane(timeline) {
  timeline.to(material.uniforms.uBend, { value: 1, duration: 1.5, ease: 'power2.inOut' }, 0);
}

function flattenPlane() {
  material.uniforms.uBend.value = 0;
  plane.rotation.x = planeRestTilt;
  plane.position.set(0, planeRestY, 0);
}

function finishStudioClose() {
  const panel = document.querySelector('.panel.active');
  if (studioTimeline) {
    studioTimeline.eventCallback('onReverseComplete', null);
    studioTimeline.kill();
    studioTimeline = null;
  }
  flattenPlane();
  document.body.classList.remove('studio-open');
  mixView.style.display = 'none';
  gsap.set('.deck-top, .mix-grid, .mix-close', { clearProps: 'transform,opacity,visibility' });
  clearSplit();
  mixView.inert = true;
  if (panel) panel.inert = false;
  sectionScrollLocked = false;
  closeMixVisuals();
  requestAnimationFrame(() => {
    if (document.body.classList.contains('studio-open')) return;
    mixView.style.display = '';
    applyRendererScale();
  });
  mixStudioToggle.focus();
}

function homeLetters(heading) {
  if (heading.querySelector('.studio-letter')) {
    return [...heading.querySelectorAll('.studio-letter')];
  }
  const chars = [...heading.textContent];
  heading.textContent = '';
  return chars.flatMap((char) => {
    if (char.trim() === '') {
      heading.appendChild(document.createTextNode(char));
      return [];
    }
    const span = document.createElement('span');
    span.className = 'studio-letter';
    span.textContent = char;
    heading.appendChild(span);
    return [span];
  });
}

function sendHomePair(timeline, atae, donum) {
  donum.style.animation = 'none';
  timeline.to(atae, {
    x: () => -(atae.getBoundingClientRect().right + 72),
    duration: 0.72,
    ease: 'power3.inOut'
  }, 0);
  timeline.to(donum, {
    x: () => window.innerWidth - donum.getBoundingClientRect().left + 72,
    duration: 0.72,
    ease: 'power3.inOut'
  }, 0);
}

function sendHomeLetters(timeline, letters) {
  const mid = Math.ceil(letters.length / 2);
  const start = 0.2;
  const stagger = 0.08;
  const duration = 0.65;
  const travel = { stagger, duration, ease: 'power3.inOut' };
  timeline.to(letters.slice(0, mid), { ...travel, y: () => -window.innerHeight }, start);
  timeline.to(letters.slice(mid), { ...travel, y: () => window.innerHeight }, start);
  const steps = Math.max(mid, letters.length - mid);
  return start + (steps - 1) * stagger + duration;
}

function showStudio() {
  if (document.body.classList.contains('studio-open')) return;
  const panel = document.querySelector('.panel.active');
  const content = panel.querySelector('.content');
  const scrollMark = panel.querySelector('.scroll-down');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  gsap.killTweensOf(content);
  const distance = window.innerWidth * 0.55;
  const holdMixer = panel.id === 'home';
  gsap.set('.deck-top', { y: holdMixer ? -window.innerHeight : -window.innerHeight * 0.5 });
  gsap.set('.mix-grid', { y: holdMixer ? window.innerHeight : window.innerHeight * 0.55 });
  if (holdMixer) gsap.set('.mix-close', { autoAlpha: 0 });

  document.body.classList.add('studio-open');
  applyRendererScale();
  mixView.inert = false;
  panel.inert = true;
  sectionScrollLocked = true;
  openMixVisuals();

  if (reduce) {
    gsap.set(content, { autoAlpha: 0 });
    if (scrollMark) gsap.set(scrollMark, { autoAlpha: 0 });
    gsap.set('.section-nav', { autoAlpha: 0 });
    gsap.set('.header', { autoAlpha: 0 });
    gsap.set('.deck-top, .mix-grid', { y: 0 });
    material.uniforms.uBend.value = 1;
    mixClose.focus();
    return;
  }

  const leavesWhole = panel.id === 'experience' || panel.id === 'contact' || panel.id === 'about' || panel.id === 'home';
  const clone = leavesWhole ? null : content.cloneNode(true);
  if (clone) {
    clone.classList.add('split-right');
    clone.setAttribute('aria-hidden', 'true');
    clone.inert = true;
    clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    const rect = content.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    panel.appendChild(clone);
    gsap.set(clone, {
      position: 'absolute',
      top: rect.top - panelRect.top,
      left: rect.left - panelRect.left,
      width: rect.width,
      height: rect.height,
      margin: 0,
      clipPath: 'inset(0 0 0 calc(50% - 1px))',
      pointerEvents: 'none'
    });
    gsap.set(content, { clipPath: 'inset(0 calc(50% - 1px) 0 0)' });
    splitClone = clone;
  }

  studioTimeline = gsap.timeline({ defaults: { duration: 0.9, ease: 'power3.inOut' } });
  bendPlane(studioTimeline);
  let deckAt = 0.22;
  if (panel.id === 'experience') {
    const label = panel.querySelector('.about-label');
    const items = panel.querySelectorAll('.list-item');
    panel.classList.add('studio-exit');
    if (label) {
      const labelBottom = label.getBoundingClientRect().bottom;
      studioTimeline.to(label, { y: -(labelBottom + 40), duration: 1.05, ease: 'power2.inOut' }, 0);
    }
    items.forEach((item, index) => {
      const rect = item.getBoundingClientRect();
      const toRight = index % 2 === 0;
      const travel = toRight ? window.innerWidth - rect.left + 48 : rect.right + 48;
      studioTimeline.to(item, { x: (toRight ? 1 : -1) * travel, duration: 1.05, ease: 'power2.inOut' }, 0);
    });
  } else if (panel.id === 'contact') {
    const pieces = [content, ...content.querySelectorAll('*')];
    const right = Math.max(...pieces.map((node) => node.getBoundingClientRect().right));
    studioTimeline.to(content, { x: -(right + 48), duration: 1.05, ease: 'power2.inOut' }, 0);
  } else if (panel.id === 'about') {
    const label = panel.querySelector('.about-label');
    const headline = panel.querySelector('.editorial-headline');
    const body = panel.querySelector('.editorial-body-spacious');
    const portrait = panel.querySelector('.profile-bg-large');
    [label, headline].filter(Boolean).forEach((el) => {
      const right = Math.max(...[el, ...el.querySelectorAll('*')].map((node) => node.getBoundingClientRect().right));
      studioTimeline.to(el, { x: -(right + 48), duration: 1.05, ease: 'power2.inOut' }, 0);
    });
    if (body) {
      const top = body.getBoundingClientRect().top;
      studioTimeline.to(body, { y: window.innerHeight - top + 48, duration: 1.05, ease: 'power2.inOut' }, 0);
    }
    if (portrait) studioTimeline.to(portrait, { autoAlpha: 0, duration: 1.05, ease: 'power2.inOut' }, 0);
  } else if (panel.id === 'home') {
    const atae = panel.querySelector('.hero-row .huge-text');
    const donum = document.getElementById('donum-btn');
    const surname = panel.querySelector('.huge-text.indent');
    const eyebrow = panel.querySelector('.eyebrow');
    surname.style.clipPath = 'none';
    sendHomePair(studioTimeline, atae, donum);
    deckAt = sendHomeLetters(studioTimeline, homeLetters(surname));
    if (eyebrow) studioTimeline.to(eyebrow, { autoAlpha: 0, y: -24, duration: 0.4 }, 0);
    studioTimeline.to('.mix-close', { autoAlpha: 1, duration: 0.35 }, deckAt);
  } else {
    studioTimeline.to(content, { x: -distance }, 0);
    studioTimeline.to(clone, { x: distance }, 0);
  }
  if (scrollMark) studioTimeline.to(scrollMark, { x: distance * 0.5, autoAlpha: 0, duration: 0.7 }, 0);
  const navExit = window.matchMedia('(max-width: 768px)').matches
    ? { x: 0, y: 90, autoAlpha: 0, duration: 0.55 }
    : { x: 80, autoAlpha: 0, duration: 0.55 };
  studioTimeline.to('.section-nav', navExit, 0);
  studioTimeline.to('.header', { y: -140, duration: 0.7, ease: 'power3.in' }, 0);
  studioTimeline.to('.deck-top', { y: 0, duration: 1, ease: 'power3.out' }, deckAt);
  studioTimeline.to('.mix-grid', { y: 0, duration: 1, ease: 'power3.out' }, deckAt);
  mixClose.focus();
}

function hideStudio() {
  if (!document.body.classList.contains('studio-open')) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !studioTimeline) {
    finishStudioClose();
    return;
  }
  if (studioTimeline.reversed()) return;
  studioTimeline.eventCallback('onReverseComplete', finishStudioClose);
  studioTimeline.reverse();
}

mixStudioToggle.addEventListener('click', () => {
  showStudio();
  if (location.hash !== '#mix') history.pushState({ studio: true }, '', '#mix');
});

function leaveStudio() {
  hideStudio();
  if (location.hash === '#mix') {
    history.pushState({ studio: false }, '', location.pathname + location.search);
  }
}

mixClose.addEventListener('click', leaveStudio);

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !document.body.classList.contains('studio-open')) return;
  event.preventDefault();
  leaveStudio();
});

window.addEventListener('popstate', () => {
  if (location.hash === '#mix') showStudio();
  else hideStudio();
});

if (location.hash === '#mix') showStudio();

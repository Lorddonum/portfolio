import { gsap } from 'gsap';
import { copyFrequency, isPlaying, FREQUENCY_BINS } from './audioEngine.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pointer = { x: 0, y: 0 };
const bins = new Uint8Array(FREQUENCY_BINS);
const bands = new Float32Array(8);
const letters = [];
let keywords = [];
let portrait = null;
let indicator = null;
let traveler = null;
let navIndex = 0;
let level = 0;

function listenPointer() {
  window.addEventListener('pointermove', (event) => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
  });
}

function letterSpan(char) {
  const span = document.createElement('span');
  span.className = 'live-letter';
  span.textContent = char;
  return span;
}

function replaceTextNode(node) {
  const fragment = document.createDocumentFragment();
  for (const char of node.textContent) {
    const piece = char === ' ' ? document.createTextNode(char) : letterSpan(char);
    fragment.appendChild(piece);
  }
  node.parentNode.replaceChild(fragment, node);
}

function wrapElementLetters(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    if (node.textContent.trim()) replaceTextNode(node);
  });
}

function wrapLiveType() {
  const selector = '#home .huge-text, #about .editorial-headline, #contact .huge-text.indent';
  document.querySelectorAll(selector).forEach(wrapElementLetters);
  document.querySelectorAll('.live-letter').forEach((letter, index) => {
    letters.push({ el: letter, index });
  });
}

function buildScrollRunner() {
  const line = document.querySelector('.scroll-down .line');
  if (!line || line.querySelector('.line-runner')) return;
  const runner = document.createElement('span');
  runner.className = 'line-runner';
  line.appendChild(runner);
}

function buildNavTraveler() {
  const nav = document.querySelector('.section-nav');
  traveler = document.createElement('span');
  traveler.className = 'nav-travel';
  traveler.setAttribute('aria-hidden', 'true');
  nav.appendChild(traveler);
}

function collectTargets() {
  keywords = [...document.querySelectorAll('.matrix-text .keyword')];
  portrait = document.querySelector('.profile-bg-large');
  indicator = document.querySelector('.indicator');
}

export function setupMotion() {
  if (reducedMotion) return;
  listenPointer();
  wrapLiveType();
  collectTargets();
  buildScrollRunner();
  buildNavTraveler();
  requestAnimationFrame(() => travelNav(0));
  window.addEventListener('resize', () => travelNav(navIndex));
}

export function travelNav(index) {
  if (reducedMotion || !traveler) return;
  navIndex = index;
  const button = document.querySelectorAll('.section-nav button')[index];
  const tick = button.querySelector('.tick');
  const navBox = button.parentElement.getBoundingClientRect();
  const tickBox = tick.getBoundingClientRect();
  gsap.to(traveler, {
    left: tickBox.left - navBox.left,
    top: tickBox.top - navBox.top,
    width: Math.max(tickBox.width, 28),
    duration: 0.7,
    ease: 'power3.inOut'
  });
}

function readBands() {
  if (isPlaying() && copyFrequency(bins)) {
    const size = Math.floor(bins.length / 8);
    for (let band = 0; band < 8; band += 1) {
      let sum = 0;
      for (let sample = 0; sample < size; sample += 1) sum += bins[band * size + sample];
      const next = sum / size / 255;
      bands[band] += (next - bands[band]) * 0.28;
    }
  } else {
    for (let band = 0; band < 8; band += 1) bands[band] += (0 - bands[band]) * 0.08;
  }
  const average = bands.reduce((sum, band) => sum + band, 0) / 8;
  level += (average - level) * 0.22;
}

function driftLetters(time) {
  letters.forEach(({ el, index }) => {
    const panel = el.closest('.panel');
    if (!panel.classList.contains('active')) return;
    const x = Math.sin(time * 0.65 + index * 0.5) * 2.1;
    const y = Math.cos(time * 0.5 + index * 0.45) * 2.4;
    el.style.transform = `translate(${x}px, ${y}px)`;
  });
}

function placeWord(word, time) {
  if (gsap.isTweening(word)) {
    word.style.translate = '0px 0px';
    return;
  }
  const lift = Math.sin(time * 1.6) * level * 8;
  word.style.translate = `0px ${lift}px`;
  if (word.classList.contains('huge-text')) {
    word.style.letterSpacing = `${-0.04 + level * 0.025}em`;
  }
}

function shiftWords(time) {
  document.querySelectorAll('.panel.active').forEach((panel) => {
    panel.querySelectorAll('.huge-text, .editorial-headline').forEach((word) => placeWord(word, time));
  });
}

function driftPortrait() {
  if (!portrait || gsap.isTweening(portrait)) return;
  const about = document.getElementById('about').classList.contains('active');
  const x = about ? -pointer.x * 18 : 0;
  const y = about ? -pointer.y * 12 : 0;
  portrait.style.translate = `${x}px ${y}px`;
}

function lightKeywords() {
  const about = document.getElementById('about').classList.contains('active');
  keywords.forEach((keyword, index) => {
    if (!about || gsap.isTweening(keyword)) {
      keyword.style.filter = '';
      return;
    }
    const band = bands[index % 8];
    keyword.style.filter = `brightness(${1 + band * 0.85})`;
  });
}

function meterSound() {
  indicator.style.transform = `scale(${1 + level * 1.8})`;
}

export function restLiveType() {
  if (reducedMotion) return;
  document.querySelectorAll('.live-letter').forEach((el) => {
    el.style.transform = '';
  });
  document.querySelectorAll('.huge-text, .editorial-headline, .profile-bg-large').forEach((el) => {
    el.style.translate = '';
    el.style.letterSpacing = '';
  });
  keywords.forEach((keyword) => {
    keyword.style.filter = '';
  });
  if (indicator) indicator.style.transform = '';
}

export function tickMotion(time) {
  if (reducedMotion) return;
  if (document.body.classList.contains('studio-open')) {
    restLiveType();
    return;
  }
  readBands();
  driftLetters(time);
  shiftWords(time);
  driftPortrait();
  lightKeywords();
  meterSound();
}

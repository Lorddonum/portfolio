import * as THREE from 'three';

const audioEl = document.getElementById('mix-audio');
audioEl.loop = true;
audioEl.volume = 0.5;

let audioCtx, source, analyser, waveAnalyser;
let eqLow, eqMid, eqHigh, filterLP, filterHP, distortion, reverb;
let dryNode, wetNode, masterVol, limiter, limiterBypass;
let compressor;
let stereoPanner, stereoWidthMid, stereoWidthSide, stereoSplitter, stereoMerger;
let currentBlend = 1.0;
let audioCtxStarted = false;
let grPeakHold = 0;

// --- Web Audio API Setup ---
function initAudioContext() {
    if (audioCtxStarted) return;
    audioCtxStarted = true;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    source = audioCtx.createMediaElementSource(audioEl);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.85;

    // Dedicated analyser for the oscilloscope (needs smaller fftSize for clear waves)
    waveAnalyser = audioCtx.createAnalyser();
    waveAnalyser.fftSize = 2048;
    waveAnalyser.smoothingTimeConstant = 0.5;

    // DSP Nodes
    eqLow = audioCtx.createBiquadFilter();
    eqLow.type = 'lowshelf';
    eqLow.frequency.value = 320;

    eqMid = audioCtx.createBiquadFilter();
    eqMid.type = 'peaking';
    eqMid.frequency.value = 1000;
    eqMid.Q.value = 0.5;

    eqHigh = audioCtx.createBiquadFilter();
    eqHigh.type = 'highshelf';
    eqHigh.frequency.value = 3200;

    filterLP = audioCtx.createBiquadFilter();
    filterLP.type = 'lowpass';
    filterLP.frequency.value = 20000;

    filterHP = audioCtx.createBiquadFilter();
    filterHP.type = 'highpass';
    filterHP.frequency.value = 20;

    distortion = audioCtx.createWaveShaper();
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
    distortion.curve = makeDistortionCurve(0);
    distortion.oversample = '4x';
    window.makeDistortionCurve = makeDistortionCurve;

    reverb = audioCtx.createConvolver();
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
    reverb.buffer = createReverb();

    dryNode = audioCtx.createGain();
    wetNode = audioCtx.createGain();
    // Default 100% wet
    wetNode.gain.value = 1;
    dryNode.gain.value = 0;

    compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 30;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;

    limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.05;

    limiterBypass = audioCtx.createGain();
    limiterBypass.gain.value = 0;

    masterVol = audioCtx.createGain();
    masterVol.gain.value = 0.5;

    // --- Stereo Width (Mid-Side Matrix) ---
    // Splits L/R, encodes to Mid+Side, scales Side by width, re-merges
    stereoSplitter = audioCtx.createChannelSplitter(2);
    stereoMerger = audioCtx.createChannelMerger(2);

    // Mid = (L+R)*0.5
    const midSumL = audioCtx.createGain(); midSumL.gain.value = 0.5;
    const midSumR = audioCtx.createGain(); midSumR.gain.value = 0.5;
    // Side = (L-R)*0.5, scaled by width
    const sideDiffL = audioCtx.createGain(); sideDiffL.gain.value = 0.5;
    const sideDiffR = audioCtx.createGain(); sideDiffR.gain.value = -0.5;

    stereoWidthMid = audioCtx.createGain(); stereoWidthMid.gain.value = 1.0; // M pass-through
    stereoWidthSide = audioCtx.createGain(); stereoWidthSide.gain.value = 1.0; // S controls width

    // Route splitter → mid/side math
    stereoSplitter.connect(midSumL, 0);    // L → Mid
    stereoSplitter.connect(midSumR, 1);    // R → Mid
    stereoSplitter.connect(sideDiffL, 0);  // L → Side
    stereoSplitter.connect(sideDiffR, 1);  // -R → Side

    midSumL.connect(stereoWidthMid);
    midSumR.connect(stereoWidthMid);
    sideDiffL.connect(stereoWidthSide);
    sideDiffR.connect(stereoWidthSide);

    // Reconstruct: newL = Mid + Side, newR = Mid - Side
    const outGainL = audioCtx.createGain(); outGainL.gain.value = 1;
    const outGainR = audioCtx.createGain(); outGainR.gain.value = 1;
    const outGainLneg = audioCtx.createGain(); outGainLneg.gain.value = -1;

    stereoWidthMid.connect(outGainL);
    stereoWidthSide.connect(outGainL);

    stereoWidthMid.connect(outGainR);
    stereoWidthSide.connect(outGainLneg);
    outGainLneg.connect(outGainR);

    outGainL.connect(stereoMerger, 0, 0); // → L
    outGainR.connect(stereoMerger, 0, 1); // → R

    // Panner after stereo matrix
    stereoPanner = audioCtx.createStereoPanner();
    stereoPanner.pan.value = 0;

    stereoMerger.connect(stereoPanner);

    // --- Chain Routing ---
    // Split immediately into DRY and WET paths
    source.connect(dryNode);
    source.connect(compressor);

    // Wet path: compressor → EQ → filters → distortion
    compressor.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(filterHP);
    filterHP.connect(filterLP);
    filterLP.connect(distortion);

    // Reverb parallel within wet path
    const revDry = audioCtx.createGain(); revDry.gain.value = 1;
    const revWet = audioCtx.createGain(); revWet.gain.value = 0;
    distortion.connect(revDry);
    distortion.connect(reverb);
    reverb.connect(revWet);
    revDry.connect(wetNode);
    revWet.connect(wetNode);

    // Merge Dry+Wet → Stereo Matrix → Panner → Master Volume
    dryNode.connect(stereoSplitter);
    wetNode.connect(stereoSplitter);
    // ↑ stereoSplitter → … → stereoMerger → stereoPanner → masterVol (wired above)
    stereoPanner.connect(masterVol);

    // Master Output limits and meters
    masterVol.connect(limiter);
    masterVol.connect(limiterBypass);

    // Both limiter states go to Visualizers, then to Destination
    limiter.connect(analyser);
    limiter.connect(waveAnalyser);

    limiterBypass.connect(analyser);
    limiterBypass.connect(waveAnalyser);

    analyser.connect(audioCtx.destination);

    // Store reverb params globally to update easily via UI
    window._revWet = revWet;
    window._revDry = revDry;

    // Start Visualizer
    drawVisualizer();
}

// --- Transport Controls ---
const playPauseBtn = document.getElementById('play-pause-btn');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const seekBarFill = document.getElementById('seek-bar-fill');
const seekBarTrack = document.getElementById('seek-bar-track');
const seekCurrent = document.getElementById('seek-current');
const seekTotal = document.getElementById('seek-total');

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

playPauseBtn.addEventListener('click', () => {
    if (!audioCtxStarted) {
        initAudioContext();
    }

    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    if (audioEl.paused) {
        audioEl.play();
    } else {
        audioEl.pause();
    }
    updatePlayPauseIcon();
});

audioEl.addEventListener('timeupdate', () => {
    if (!audioEl.duration) return;
    const pct = (audioEl.currentTime / audioEl.duration) * 100;
    seekBarFill.style.width = pct + '%';
    seekCurrent.textContent = formatTime(audioEl.currentTime);
    seekTotal.textContent = formatTime(audioEl.duration);
});

seekBarTrack.addEventListener('click', (e) => {
    const rect = seekBarTrack.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    audioEl.currentTime = fraction * audioEl.duration;
});

const spectrumCanvas = document.getElementById('spectrum-canvas');
const spectrumCtx = spectrumCanvas.getContext('2d');
const oscCanvas = document.getElementById('oscilloscope-canvas');
const oscCtx = oscCanvas.getContext('2d');
const peakMeter = document.getElementById('peak-meter');
const grMeter = document.getElementById('gr-meter');

// --- 3D Background System: Audio-Reactive Particle Constellation ---
const bgCanvas = document.getElementById('bg-canvas');
const bgScene = new THREE.Scene();
bgScene.fog = new THREE.FogExp2(0x000000, 0.005);

const bgCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 800);
bgCamera.position.set(0, 0, 150);

const bgRenderer = new THREE.WebGLRenderer({ canvas: bgCanvas, alpha: true, antialias: true });
bgRenderer.setSize(window.innerWidth, window.innerHeight);
bgRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const particleCount = 200;
const maxConnections = 2000;
const particlesData = [];
const boxSize = 250;

// 1. Particles (Nodes)
const pGeometry = new THREE.BufferGeometry();
const particlePositions = new Float32Array(particleCount * 3);

for (let i = 0; i < particleCount; i++) {
    const x = (Math.random() - 0.5) * boxSize;
    const y = (Math.random() - 0.5) * boxSize;
    const z = (Math.random() - 0.5) * boxSize;

    particlePositions[i * 3] = x;
    particlePositions[i * 3 + 1] = y;
    particlePositions[i * 3 + 2] = z;

    particlesData.push({
        velocity: new THREE.Vector3(
            (Math.random() - 0.5) * 0.4,
            (Math.random() - 0.5) * 0.4,
            (Math.random() - 0.5) * 0.4
        )
    });
}

pGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
const pMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.5,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending
});
const particleSystem = new THREE.Points(pGeometry, pMaterial);
bgScene.add(particleSystem);

// 2. Connections (Lines)
const lGeometry = new THREE.BufferGeometry();
const linePositions = new Float32Array(maxConnections * 6); // 2 vertices per line (x,y,z)
const lineColors = new Float32Array(maxConnections * 6); // RGB per vertex

lGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage));
lGeometry.setAttribute('color', new THREE.BufferAttribute(lineColors, 3).setUsage(THREE.DynamicDrawUsage));

const lMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending
});
const linesMesh = new THREE.LineSegments(lGeometry, lMaterial);
bgScene.add(linesMesh);

// Group to slowly rotate the entire constellation
const constellationGroup = new THREE.Group();
constellationGroup.add(particleSystem);
constellationGroup.add(linesMesh);
bgScene.add(constellationGroup);

function resizeCanvas() {
    // Make it visually sharp
    const rect = spectrumCanvas.parentElement.getBoundingClientRect();
    spectrumCanvas.width = rect.width * window.devicePixelRatio;
    spectrumCanvas.height = (rect.height / 2) * window.devicePixelRatio;
    spectrumCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
    spectrumCanvas.style.width = rect.width + 'px';
    spectrumCanvas.style.height = (rect.height / 2) + 'px';

    oscCanvas.width = rect.width * window.devicePixelRatio;
    oscCanvas.height = (rect.height / 2) * window.devicePixelRatio;
    oscCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
    oscCanvas.style.width = rect.width + 'px';
    oscCanvas.style.height = (rect.height / 2) + 'px';

    if (bgCamera && bgRenderer) {
        bgCamera.aspect = window.innerWidth / window.innerHeight;
        bgCamera.updateProjectionMatrix();
        bgRenderer.setSize(window.innerWidth, window.innerHeight);
    }
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas(); // Initial call

let peakVolume = 0;

function drawVisualizer() {
    requestAnimationFrame(drawVisualizer);
    if (!audioCtxStarted) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    const rect = spectrumCanvas.parentElement.getBoundingClientRect();
    const w = rect.width; // Use full width
    const h = rect.height / 2 - 5; // Split height for two canvases, accounting for gap

    // --- 1. Draw Spectrum Bar Graph ---
    spectrumCtx.clearRect(0, 0, w, h);

    const barWidth = 3;
    const gap = 2;
    const numBars = Math.floor(w / (barWidth + gap));
    const step = Math.floor(bufferLength / numBars);

    let sum = 0;

    for (let i = 0; i < numBars; i++) {
        const value = dataArray[i * step];
        const percent = value / 255;
        const barHeight = percent * h;

        sum += value;

        // Gradient based on frequency
        const hue = i / numBars * 60 + 300; // Pink to purple/blue

        // Always ensure a tiny minimum height so it doesn't look empty when silent
        const displayHeight = Math.max(barHeight, 2);

        spectrumCtx.fillStyle = `hsla(${hue}, 100%, 60%, 0.8)`;
        spectrumCtx.fillRect(i * (barWidth + gap), h - displayHeight, barWidth, displayHeight);

        // Add subtle cap/glow above bar
        spectrumCtx.fillStyle = '#fff';
        spectrumCtx.fillRect(i * (barWidth + gap), h - displayHeight - 2, barWidth, 1);
    }

    // Rough Peak Meter Calculation (RMS)
    const average = sum / numBars;
    const targetPeak = (average / 150) * 100; // scaled

    // Smooth peak falloff
    if (targetPeak > peakVolume) {
        peakVolume = targetPeak * 0.8 + peakVolume * 0.2; // faster attack
    } else {
        peakVolume *= 0.85; // slower decay
    }

    // Cap at 100%
    const cappedPeak = Math.min(100, Math.max(0, peakVolume));
    peakMeter.style.height = `${cappedPeak}%`;

    // --- 2. Draw Real-Time Oscilloscope ---
    if (waveAnalyser) {
        oscCtx.clearRect(0, 0, w, h);
        const waveBufferLength = waveAnalyser.frequencyBinCount;
        const waveDataArray = new Float32Array(waveBufferLength);
        waveAnalyser.getFloatTimeDomainData(waveDataArray);

        oscCtx.lineWidth = 2;
        oscCtx.strokeStyle = 'rgba(0, 255, 136, 0.8)'; // Neon green
        oscCtx.shadowBlur = 10;
        oscCtx.shadowColor = 'rgba(0, 255, 136, 0.5)';
        oscCtx.beginPath();

        const sliceWidth = w * 1.0 / waveBufferLength;
        let x = 0;

        for (let i = 0; i < waveBufferLength; i++) {
            const v = waveDataArray[i] * 0.5 + 0.5; // norm from -1/1 to 0/1
            const y = v * h;

            if (i === 0) {
                oscCtx.moveTo(x, y);
            } else {
                oscCtx.lineTo(x, y);
            }
            x += sliceWidth;
        }
        oscCtx.lineTo(w, h / 2);
        oscCtx.stroke();
        oscCtx.shadowBlur = 0; // Reset
    }

    // --- 3. Compressor Gain Reduction Meter ---
    if (compressor) {
        let gr = compressor.reduction;
        if (typeof gr !== 'number') gr = gr.value || 0;

        // Scale: 6dB = 100% so smaller reductions are prominent
        const maxGr = 6;
        let grPct = (Math.abs(gr) / maxGr) * 100;
        grPct = Math.min(100, Math.max(0, grPct));

        // Peak-hold with fast attack, slow decay
        if (grPct > grPeakHold) {
            grPeakHold = grPct; // instant attack
        } else {
            grPeakHold *= 0.92; // slow decay, stays visible longer
        }

        grMeter.style.height = `${grPeakHold}%`;

        // Show a glow on the compressor section when actively compressing
        const compPanel = grMeter.closest('.mix-section');
        if (compPanel) {
            if (grPeakHold > 5) {
                const intensity = Math.min(0.6, grPeakHold / 100);
                compPanel.style.boxShadow = `0 8px 32px rgba(0,0,0,0.4), inset 0 0 30px rgba(255, 45, 120, ${intensity})`;
            } else {
                compPanel.style.boxShadow = '';
            }
        }
    }

    // Sidechain Visuals: Pulse glass panels based on loud peaks
    // We only want a noticeable pulse on heavy kicks (e.g. peak > 70%)
    const panels = document.querySelectorAll('.glass-panel');
    let glowOpacity = 0;
    if (cappedPeak > 60) {
        // Map 60-100 to 0.0 - 0.4 opacity
        glowOpacity = ((cappedPeak - 60) / 40) * 0.4;
    }

    panels.forEach(panel => {
        panel.style.boxShadow = `0 8px 32px rgba(0, 0, 0, 0.4), inset 0 0 40px rgba(255, 45, 120, ${glowOpacity})`;
        panel.style.borderColor = `rgba(255, 255, 255, ${0.08 + glowOpacity})`;
    });

    // --- 3D Background Synesthesia: Audio-Reactive Particle Constellation ---
    let sumLow = 0, sumMid = 0, sumHigh = 0;
    const third = Math.floor(bufferLength / 3);
    for (let i = 0; i < third; i++) sumLow += dataArray[i];
    for (let i = third; i < 2 * third; i++) sumMid += dataArray[i];
    for (let i = 2 * third; i < bufferLength; i++) sumHigh += dataArray[i];

    const lowN = (sumLow / third) / 255;
    const midN = (sumMid / third) / 255;
    const highN = (sumHigh / (bufferLength - 2 * third)) / 255;

    // Base Audio Modifiers
    const audioScale = 1.0 + lowN * 2.0;       // Increases speed globally
    const connDist = 35 + lowN * 30;           // Reach further to connect
    const highlightIntensity = Math.min(1.0, lowN * 1.5 + highN * 1.5); // Color pop

    // 1. Update Particle Positions (bounce around box)
    const positions = particleSystem.geometry.attributes.position.array;
    const halfBox = boxSize / 2;

    for (let i = 0; i < particleCount; i++) {
        const pData = particlesData[i];

        positions[i * 3] += pData.velocity.x * audioScale;
        positions[i * 3 + 1] += pData.velocity.y * audioScale;
        positions[i * 3 + 2] += pData.velocity.z * audioScale;

        // Bounce horizontally
        if (positions[i * 3] > halfBox || positions[i * 3] < -halfBox) pData.velocity.x *= -1;
        // Bounce vertically
        if (positions[i * 3 + 1] > halfBox || positions[i * 3 + 1] < -halfBox) pData.velocity.y *= -1;
        // Bounce depth
        if (positions[i * 3 + 2] > halfBox || positions[i * 3 + 2] < -halfBox) pData.velocity.z *= -1;
    }
    particleSystem.geometry.attributes.position.needsUpdate = true;

    // 2. Compute Connections
    let vertexpos = 0;
    let colorpos = 0;
    let numConnected = 0;

    for (let i = 0; i < particleCount; i++) {
        for (let j = i + 1; j < particleCount; j++) {
            const dx = positions[i * 3] - positions[j * 3];
            const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
            const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
            const distSq = dx * dx + dy * dy + dz * dz;

            if (distSq < connDist * connDist) {
                // Determine connection opacity
                const dist = Math.sqrt(distSq);
                const alpha = 1.0 - (dist / connDist);

                // Colors: Base greyish, transitioning to Pink/White on audio spikes
                const r = ((1.0 - highlightIntensity) * 0.4 + highlightIntensity * 1.0) * alpha;
                const g = ((1.0 - highlightIntensity) * 0.4 + highlightIntensity * 0.176) * alpha;
                const b = ((1.0 - highlightIntensity) * 0.4 + highlightIntensity * 0.47) * alpha;

                // Add vertices
                linePositions[vertexpos++] = positions[i * 3];
                linePositions[vertexpos++] = positions[i * 3 + 1];
                linePositions[vertexpos++] = positions[i * 3 + 2];

                linePositions[vertexpos++] = positions[j * 3];
                linePositions[vertexpos++] = positions[j * 3 + 1];
                linePositions[vertexpos++] = positions[j * 3 + 2];

                // Add colors (same for both ends of the line)
                lineColors[colorpos++] = r;
                lineColors[colorpos++] = g;
                lineColors[colorpos++] = b;
                lineColors[colorpos++] = r;
                lineColors[colorpos++] = g;
                lineColors[colorpos++] = b;

                numConnected++;
                if (numConnected >= maxConnections) break;
            }
        }
        if (numConnected >= maxConnections) break;
    }

    linesMesh.geometry.setDrawRange(0, numConnected * 2);
    linesMesh.geometry.attributes.position.needsUpdate = true;
    linesMesh.geometry.attributes.color.needsUpdate = true;

    // 3. Overall Scene Animation
    // Constellation slightly expands on bass and rotates slowly
    constellationGroup.rotation.y += 0.0005 * audioScale;
    constellationGroup.rotation.x += 0.0002 * audioScale;
    const targetScale = 1.0 + lowN * 0.15;
    const currentScale = constellationGroup.scale.x;
    const newScale = currentScale + (targetScale - currentScale) * 0.1; // Smooth interpolate
    constellationGroup.scale.set(newScale, newScale, newScale);

    bgRenderer.render(bgScene, bgCamera);
}


// --- UI Wiring (Custom SVG Knobs) ---

function createKnob(containerId, onChangeFn) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const min = parseFloat(container.dataset.min);
    const max = parseFloat(container.dataset.max);
    let val = parseFloat(container.dataset.val);
    const label = container.dataset.label;
    const suffix = container.dataset.suffix || "";
    const sub = container.dataset.sub || "";
    const isLog = container.dataset.log === "true";

    // Build DOM
    container.innerHTML = `
        <span class="knob-label">${label}</span>
        ${sub ? `<span class="knob-sub">${sub}</span>` : ''}
        <svg class="knob-svg" viewBox="0 0 100 100" width="60" height="60">
            <defs>
                <linearGradient id="knobGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#2a2a2a" />
                    <stop offset="100%" stop-color="#0a0a0a" />
                </linearGradient>
            </defs>
            <!-- Background track -->
            <path class="knob-track" d="M 20 80 A 40 40 0 1 1 80 80" />
            <!-- Fill arc -->
            <path class="knob-fill" d="" />
            <!-- Inner Dial -->
            <circle class="knob-base" cx="50" cy="50" r="30" />
            <circle class="knob-dial" cx="50" cy="50" r="26" />
            <!-- Indicator Line -->
            <line class="knob-indicator" x1="50" y1="50" x2="50" y2="28" />
        </svg>
        <div class="val-display">${formatVal(val)}${suffix}</div>
    `;

    const svg = container.querySelector('.knob-svg');
    const fillPath = container.querySelector('.knob-fill');
    const indicator = container.querySelector('.knob-indicator');
    const display = container.querySelector('.val-display');

    let isDragging = false;
    let startY = 0;
    let startVal = val;

    function formatVal(v) {
        if (isLog) {
            return v >= 1000 ? (v / 1000).toFixed(1) + ' k' : Math.round(v);
        }
        return (Math.round(v * 100) / 100).toFixed(parseFloat(max) - parseFloat(min) > 10 ? 0 : 1);
    }

    function updateVisuals(normalized) {
        // Normalized is 0.0 to 1.0
        // Angle range: -135 to +135 degrees (0 starts at top)
        const angle = -135 + (normalized * 270);

        // Rotate indicator line
        indicator.setAttribute('transform', `rotate(${angle}, 50, 50)`);

        // Draw arc
        const endAngleRad = (angle - 90) * (Math.PI / 180);
        const startAngleRad = -225 * (Math.PI / 180); // -135 - 90

        const r = 40;
        const cx = 50;
        const cy = 50;

        const startX = cx + r * Math.cos(startAngleRad);
        const startY = cy + r * Math.sin(startAngleRad);

        const endX = cx + r * Math.cos(endAngleRad);
        const endY = cy + r * Math.sin(endAngleRad);

        const largeArcFlag = normalized > 0.666 ? 1 : 0; // > 180 degrees

        const d = `M ${startX} ${startY} A ${r} ${r} 0 ${largeArcFlag} 1 ${endX} ${endY}`;
        fillPath.setAttribute('d', d);

        display.textContent = formatVal(val) + suffix;
    }

    function setValFromNormalized(norm) {
        if (isLog) {
            // Logarithmic mapping (e.g. for frequencies 20Hz - 20kHz)
            const minLog = Math.log10(min);
            const maxLog = Math.log10(max);
            const scale = maxLog - minLog;
            val = Math.pow(10, minLog + scale * norm);
        } else {
            // Linear mapping
            val = min + (max - min) * norm;
        }

        // Clamp
        val = Math.max(min, Math.min(max, val));

        updateVisuals(norm);
        if (audioCtxStarted) onChangeFn(val);
    }

    function initFromDataVal() {
        let norm = 0;
        if (isLog) {
            const minLog = Math.log10(min);
            const maxLog = Math.log10(max);
            norm = (Math.log10(val) - minLog) / (maxLog - minLog);
        } else {
            norm = (val - min) / (max - min);
        }
        updateVisuals(norm);
    }

    // Events
    svg.addEventListener('mousedown', (e) => {
        isDragging = true;
        startY = e.clientY;
        startVal = val;
        document.body.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const deltaY = startY - e.clientY;
        // Sensitivity: 200px drag = full range
        const deltaNorm = deltaY / 200;

        let startNorm = 0;
        if (isLog) {
            startNorm = (Math.log10(startVal) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));
        } else {
            startNorm = (startVal - min) / (max - min);
        }

        let newNorm = Math.max(0, Math.min(1, startNorm + deltaNorm));
        setValFromNormalized(newNorm);
    });

    window.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            document.body.style.cursor = '';
        }
    });

    initFromDataVal();

    // Return a method so presets can programmatically update this knob
    return {
        setValue: function (newVal) {
            val = Math.max(min, Math.min(max, newVal));
            let norm = 0;
            if (isLog) {
                const minLog = Math.log10(min);
                const maxLog = Math.log10(max);
                norm = (Math.log10(val) - minLog) / (maxLog - minLog);
            } else {
                norm = (val - min) / (max - min);
            }
            updateVisuals(norm);
            if (audioCtxStarted) onChangeFn(val);
        }
    };
}

// Initialize all knobs and store their control objects
const knobs = {
    'eq-low': createKnob('eq-low', v => { if (eqLow) eqLow.gain.value = v; }),
    'eq-mid': createKnob('eq-mid', v => { if (eqMid) eqMid.gain.value = v; }),
    'eq-high': createKnob('eq-high', v => { if (eqHigh) eqHigh.gain.value = v; }),
    'filter-hp': createKnob('filter-hp', v => { if (filterHP) filterHP.frequency.value = v; }),
    'filter-lp': createKnob('filter-lp', v => { if (filterLP) filterLP.frequency.value = v; }),
    'fx-dist': createKnob('fx-dist', v => { if (distortion) distortion.curve = window.makeDistortionCurve(v * 2); }),
    'fx-reverb': createKnob('fx-reverb', v => {
        if (window._revWet && window._revDry) {
            window._revWet.gain.value = v;
            window._revDry.gain.value = 1 - v;
        }
    }),
    'comp-thresh': createKnob('comp-thresh', v => { if (compressor) compressor.threshold.value = v; }),
    'comp-ratio': createKnob('comp-ratio', v => { if (compressor) compressor.ratio.value = v; }),
    'stereo-width': createKnob('stereo-width', v => {
        // v=0 → mono (no side), v=1 → normal, v=2 → hyper-wide
        if (stereoWidthSide) stereoWidthSide.gain.value = v;
    }),
    'stereo-pan': createKnob('stereo-pan', v => {
        if (stereoPanner) stereoPanner.pan.value = v;
    }),
    'master-blend': createKnob('master-blend', v => {
        currentBlend = v;
        if (dryNode && wetNode) {
            dryNode.gain.value = Math.cos(v * 0.5 * Math.PI);
            wetNode.gain.value = Math.cos((1.0 - v) * 0.5 * Math.PI);
        }
    }),
    'master-vol': createKnob('master-vol', v => { if (masterVol) masterVol.gain.value = v; })
};

// --- Mono Toggle ---
const monoToggle = document.getElementById('stereo-mono');
if (monoToggle) {
    monoToggle.addEventListener('change', (e) => {
        if (!audioCtxStarted) return;
        if (e.target.checked) {
            // Collapse to mono: set Side gain to 0
            stereoWidthSide.gain.value = 0;
            // Reflect on knob UI
            if (knobs['stereo-width']) knobs['stereo-width'].setValue(0);
        } else {
            // Restore width from knob
            const widthKnob = document.getElementById('stereo-width');
            const widthVal = widthKnob ? parseFloat(widthKnob.dataset.val || '1') : 1;
            if (stereoWidthSide) stereoWidthSide.gain.value = widthVal;
        }
    });
}

// --- Varispeed Slider ---
const tapeSpeedSlider = document.getElementById('tape-speed');
const tapeSpeedVal = document.getElementById('tape-speed-val');
if (tapeSpeedSlider && tapeSpeedVal) {
    tapeSpeedSlider.addEventListener('input', (e) => {
        const speed = parseFloat(e.target.value);
        tapeSpeedVal.textContent = speed.toFixed(2) + 'x';
        if (audioEl) {
            audioEl.playbackRate = speed;
        }
    });
}

// --- Presets Logic ---
const presets = {
    flat: { 'eq-low': 0, 'eq-mid': 0, 'eq-high': 0, 'filter-hp': 20, 'filter-lp': 20000, 'fx-dist': 0, 'fx-reverb': 0, 'master-vol': 0.5 },
    club: { 'eq-low': 4.5, 'eq-mid': -1.5, 'eq-high': 2.0, 'filter-hp': 40, 'filter-lp': 18000, 'fx-dist': 2.5, 'fx-reverb': 0.15, 'master-vol': 0.55 },
    lofi: { 'eq-low': 1.0, 'eq-mid': 3.0, 'eq-high': -8.0, 'filter-hp': 150, 'filter-lp': 8000, 'fx-dist': 8.0, 'fx-reverb': 0.35, 'master-vol': 0.6 },
    bass: { 'eq-low': 6.0, 'eq-mid': -2.0, 'eq-high': -1.0, 'filter-hp': 30, 'filter-lp': 1200, 'fx-dist': 1.0, 'fx-reverb': 0.05, 'master-vol': 0.5 }
};

const presetBtns = document.querySelectorAll('.preset-btn');
presetBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        // Update active class
        presetBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');

        // Apply preset values
        const presetName = e.target.dataset.preset;
        const config = presets[presetName];
        if (config) {
            for (const [knobId, val] of Object.entries(config)) {
                if (knobs[knobId]) {
                    knobs[knobId].setValue(val);
                }
            }
        }
    });
});


const limiterToggle = document.getElementById('master-limiter');
limiterToggle.addEventListener('change', (e) => {
    if (!audioCtxStarted) return;

    // Disconnect old
    masterVol.disconnect();

    if (e.target.checked) {
        limiter.disconnect();
        limiterBypass.disconnect();

        masterVol.connect(limiter);
        limiter.connect(analyser);
        limiter.connect(waveAnalyser);
    } else {
        limiter.disconnect();
        limiterBypass.disconnect();

        masterVol.connect(limiterBypass);
        limiterBypass.gain.value = 1;
        limiterBypass.connect(analyser);
        limiterBypass.connect(waveAnalyser);
    }
});

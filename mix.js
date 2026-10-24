import {
    togglePlayback,
    seekToFraction,
    subscribe,
    isPlaying,
    playbackTime,
    copyFrequency,
    copyWaveform,
    gainReduction,
    hasAnalyser,
    getMix,
    setMixParam,
    enableMono,
    disableMono,
    enableLimiter,
    disableLimiter,
    FREQUENCY_BINS,
    WAVEFORM_SAMPLES,
} from './audioEngine.js';

const playPauseBtn = document.getElementById('mix-play');
const playIcon = document.getElementById('mix-play-icon');
const pauseIcon = document.getElementById('mix-pause-icon');
const seekBarFill = document.getElementById('mix-seek-fill');
const seekBarTrack = document.getElementById('mix-seek-track');
const seekCurrent = document.getElementById('mix-seek-current');
const seekTotal = document.getElementById('mix-seek-total');

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

function renderTransport() {
    const playing = isPlaying();
    playIcon.style.display = playing ? 'none' : 'block';
    pauseIcon.style.display = playing ? 'block' : 'none';
}

function renderSeek() {
    const { current, duration } = playbackTime();
    if (!duration) return;
    seekBarFill.style.width = `${(current / duration) * 100}%`;
    seekCurrent.textContent = formatTime(current);
    seekTotal.textContent = formatTime(duration);
}

subscribe((type) => {
    if (type === 'transport') renderTransport();
    if (type === 'time') renderSeek();
});

playPauseBtn.addEventListener('click', () => {
    togglePlayback();
});

let seeking = false;

function fractionFromPointer(event) {
    const rect = seekBarTrack.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return (event.clientX - rect.left) / rect.width;
}

seekBarTrack.addEventListener('pointerdown', (event) => {
    seeking = true;
    seekBarTrack.setPointerCapture(event.pointerId);
    seekToFraction(fractionFromPointer(event));
});

seekBarTrack.addEventListener('pointermove', (event) => {
    if (!seeking) return;
    seekToFraction(fractionFromPointer(event));
});

function endSeek(event) {
    if (!seeking) return;
    seeking = false;
    if (seekBarTrack.hasPointerCapture(event.pointerId)) {
        seekBarTrack.releasePointerCapture(event.pointerId);
    }
}

seekBarTrack.addEventListener('pointerup', endSeek);
seekBarTrack.addEventListener('pointercancel', endSeek);

const spectrumCanvas = document.getElementById('spectrum-canvas');
const spectrumCtx = spectrumCanvas.getContext('2d');
const oscCanvas = document.getElementById('oscilloscope-canvas');
const oscCtx = oscCanvas.getContext('2d');
const peakMeter = document.getElementById('peak-meter');
const grMeter = document.getElementById('gr-meter');

const mixView = document.getElementById('mix-view');
let spectrumWidth = 1;
let spectrumHeight = 1;
let paintedPeakGlow = '';

function resizeCanvas() {
    const rect = spectrumCanvas.parentElement.getBoundingClientRect();
    const width = Math.max(rect.width, 1);
    const halfHeight = Math.max(rect.height / 2, 1);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    spectrumWidth = width;
    spectrumHeight = halfHeight;

    spectrumCanvas.width = Math.floor(width * ratio);
    spectrumCanvas.height = Math.floor(halfHeight * ratio);
    spectrumCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    spectrumCanvas.style.width = width + 'px';
    spectrumCanvas.style.height = halfHeight + 'px';

    oscCanvas.width = Math.floor(width * ratio);
    oscCanvas.height = Math.floor(halfHeight * ratio);
    oscCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    oscCanvas.style.width = width + 'px';
    oscCanvas.style.height = halfHeight + 'px';
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas(); // Initial call

let peakVolume = 0;
let grPeakHold = 0;
let studioActive = false;
let mixFrame = 0;
const frequencyBins = new Uint8Array(FREQUENCY_BINS);
const waveform = new Float32Array(WAVEFORM_SAMPLES);

function drawSpectrum(bins) {
    const width = spectrumWidth;
    const height = spectrumHeight;
    spectrumCtx.clearRect(0, 0, width, height);
    const barWidth = 3;
    const gap = 2;
    const barCount = Math.max(1, Math.floor(width / (barWidth + gap)));
    const step = Math.max(1, Math.floor(bins.length / barCount));
    let sum = 0;
    for (let i = 0; i < barCount; i++) {
        const level = bins[i * step];
        sum += level;
        const barHeight = Math.max((level / 255) * height, 2);
        const x = i * (barWidth + gap);
        spectrumCtx.fillStyle = 'hsla(' + ((i / barCount) * 60 + 300) + ', 100%, 60%, 0.8)';
        spectrumCtx.fillRect(x, height - barHeight, barWidth, barHeight);
        spectrumCtx.fillStyle = '#fff';
        spectrumCtx.fillRect(x, height - barHeight - 2, barWidth, 1);
    }
    return sum / barCount;
}

function drawOscilloscope() {
    if (!copyWaveform(waveform)) return;
    const width = spectrumWidth;
    const height = spectrumHeight;
    const stride = 4;
    oscCtx.clearRect(0, 0, width, height);
    oscCtx.lineWidth = 2;
    oscCtx.strokeStyle = 'rgba(0, 255, 136, 0.8)';
    oscCtx.beginPath();
    const sliceWidth = width / Math.ceil(WAVEFORM_SAMPLES / stride);
    let x = 0;
    for (let i = 0; i < WAVEFORM_SAMPLES; i += stride) {
        const y = (waveform[i] * 0.5 + 0.5) * height;
        if (i === 0) oscCtx.moveTo(x, y);
        else oscCtx.lineTo(x, y);
        x += sliceWidth;
    }
    oscCtx.lineTo(width, height / 2);
    oscCtx.stroke();
}

function applyPeakGlow(peak) {
    const glow = peak > 60 ? ((peak - 60) / 40) * 0.4 : 0;
    const next = glow.toFixed(3);
    if (next === paintedPeakGlow) return;
    paintedPeakGlow = next;
    mixView.style.setProperty('--peak-glow', next);
}

function drawVisualizer() {
    if (!studioActive) {
        mixFrame = 0;
        return;
    }
    mixFrame = requestAnimationFrame(drawVisualizer);
    if (!hasAnalyser() || !copyFrequency(frequencyBins)) return;

    const average = drawSpectrum(frequencyBins);
    const targetPeak = (average / 150) * 100;
    if (targetPeak > peakVolume) peakVolume = targetPeak * 0.8 + peakVolume * 0.2;
    else peakVolume *= 0.85;
    const cappedPeak = Math.min(100, Math.max(0, peakVolume));
    peakMeter.style.height = cappedPeak + '%';

    drawOscilloscope();

    const grPct = Math.min(100, Math.max(0, (Math.abs(gainReduction()) / 6) * 100));
    if (grPct > grPeakHold) grPeakHold = grPct;
    else grPeakHold *= 0.92;
    grMeter.style.height = grPeakHold + '%';
    applyPeakGlow(cappedPeak);
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
            return v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz';
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

        display.textContent = isLog ? formatVal(val) : formatVal(val) + suffix;
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
        onChangeFn(val);
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
            onChangeFn(val);
        }
    };
}

// Initialize all knobs and store their control objects
const knobs = {
    'eq-low': createKnob('eq-low', (gain) => setMixParam('eqLow', gain)),
    'eq-mid': createKnob('eq-mid', (gain) => setMixParam('eqMid', gain)),
    'eq-high': createKnob('eq-high', (gain) => setMixParam('eqHigh', gain)),
    'filter-hp': createKnob('filter-hp', (frequency) => setMixParam('filterHp', frequency)),
    'filter-lp': createKnob('filter-lp', (frequency) => setMixParam('filterLp', frequency)),
    'fx-dist': createKnob('fx-dist', (amount) => setMixParam('drive', amount)),
    'fx-reverb': createKnob('fx-reverb', (amount) => setMixParam('reverb', amount)),
    'comp-thresh': createKnob('comp-thresh', (db) => setMixParam('compThresh', db)),
    'comp-ratio': createKnob('comp-ratio', (ratio) => setMixParam('compRatio', ratio)),
    'stereo-width': createKnob('stereo-width', (width) => setMixParam('stereoWidth', width)),
    'stereo-pan': createKnob('stereo-pan', (value) => setMixParam('pan', value)),
    'master-blend': createKnob('master-blend', (amount) => setMixParam('blend', amount)),
    'master-vol': createKnob('master-vol', (gain) => setMixParam('volume', gain)),
};

const storedMix = getMix();
const knobMix = {
    'eq-low': storedMix.eqLow,
    'eq-mid': storedMix.eqMid,
    'eq-high': storedMix.eqHigh,
    'filter-hp': storedMix.filterHp,
    'filter-lp': storedMix.filterLp,
    'fx-dist': storedMix.drive,
    'fx-reverb': storedMix.reverb,
    'comp-thresh': storedMix.compThresh,
    'comp-ratio': storedMix.compRatio,
    'stereo-width': storedMix.stereoWidth,
    'stereo-pan': storedMix.pan,
    'master-blend': storedMix.blend,
    'master-vol': storedMix.volume,
};
for (const [id, amount] of Object.entries(knobMix)) {
    knobs[id].setValue(amount);
}

// --- Mono Toggle ---
const monoToggle = document.getElementById('stereo-mono');
monoToggle.addEventListener('change', (event) => {
    if (event.target.checked) {
        enableMono();
        knobs['stereo-width'].setValue(0);
    } else {
        disableMono();
        const widthVal = parseFloat(document.getElementById('stereo-width').dataset.val || '1');
        knobs['stereo-width'].setValue(widthVal);
    }
});

const tapeSpeedSlider = document.getElementById('tape-speed');
const tapeSpeedVal = document.getElementById('tape-speed-val');
tapeSpeedSlider.addEventListener('input', (event) => {
    const speed = parseFloat(event.target.value);
    tapeSpeedVal.textContent = speed.toFixed(2) + 'x';
    setMixParam('tapeSpeed', speed);
});
tapeSpeedSlider.value = storedMix.tapeSpeed;
tapeSpeedVal.textContent = storedMix.tapeSpeed.toFixed(2) + 'x';
monoToggle.checked = storedMix.mono;

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
limiterToggle.checked = storedMix.limiter;
limiterToggle.addEventListener('change', (event) => {
    if (event.target.checked) enableLimiter();
    else disableLimiter();
});

let visualsQueued = false;

export function openMixVisuals() {
    studioActive = true;
    if (mixFrame || visualsQueued) return;
    visualsQueued = true;
    requestAnimationFrame(() => {
        visualsQueued = false;
        if (!studioActive) return;
        resizeCanvas();
        if (!mixFrame) mixFrame = requestAnimationFrame(drawVisualizer);
    });
}

export function closeMixVisuals() {
    studioActive = false;
    if (mixFrame) cancelAnimationFrame(mixFrame);
    mixFrame = 0;
}

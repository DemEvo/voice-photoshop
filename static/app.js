document.addEventListener('DOMContentLoaded', () => {
    // ===================================================================
    // STATE
    // ===================================================================
    let fileId = null;
    let currentBlobUrl = null;
    let isProcessing = false;
    let pendingRequest = false;
    let uiMode = 'simple'; // 'simple' | 'pro'
    let macroDisconnected = false; // true when user manually edits Pro sliders

    // ===================================================================
    // DOM ELEMENTS
    // ===================================================================
    const uploadPanel = document.getElementById('upload-panel');
    const editorPanel = document.getElementById('editor-panel');
    const dropArea = document.getElementById('drop-area');
    const fileInput = document.getElementById('file-input');
    const uploadLoader = document.getElementById('upload-loader');
    const togglePro = document.getElementById('toggle-pro');
    const simpleControls = document.getElementById('simple-controls');
    const proControls = document.getElementById('pro-controls');
    const labelSimple = document.getElementById('label-simple');
    const labelPro = document.getElementById('label-pro');

    // Macro Sliders (Simple Mode)
    const macroSliders = {
        clarity: document.getElementById('macro-clarity'),
        warmth: document.getElementById('macro-warmth'),
        age: document.getElementById('macro-age')
    };
    const macroDisplays = {
        clarity: document.getElementById('val-clarity'),
        warmth: document.getElementById('val-warmth'),
        age: document.getElementById('val-age')
    };

    // Pro Sliders (all 10 engineering parameters)
    const proSliders = {
        pitch_ratio: document.getElementById('pitch_ratio'),
        formant_ratio: document.getElementById('formant_ratio'),
        presence_db: document.getElementById('presence_db'),
        compression_level: document.getElementById('compression_level'),
        f2_shift: document.getElementById('f2_shift'),
        jitter_mod: document.getElementById('jitter_mod'),
        breathiness_mod: document.getElementById('breathiness_mod'),
        noise_gate_db: document.getElementById('noise_gate_db'),
        deesser_amount: document.getElementById('deesser_amount')
    };
    const proDisplays = {
        pitch_ratio: document.getElementById('val-pitch'),
        formant_ratio: document.getElementById('val-formant'),
        presence_db: document.getElementById('val-presence'),
        compression_level: document.getElementById('val-comp'),
        f2_shift: document.getElementById('val-f2'),
        jitter_mod: document.getElementById('val-jitter'),
        breathiness_mod: document.getElementById('val-breath'),
        noise_gate_db: document.getElementById('val-gate'),
        deesser_amount: document.getElementById('val-deesser')
    };

    // Playback
    const audioPlayer = document.getElementById('audio-player');
    const btnPlay = document.getElementById('btn-play');
    const timeDisplay = document.getElementById('time-display');
    const btnExport = document.getElementById('btn-export');
    const btnReset = document.getElementById('btn-reset');
    const statusBar = document.getElementById('status-bar');

    // Visualizer
    const canvas = document.getElementById('waveform-canvas');
    const ctx = canvas.getContext('2d');
    let audioCtx = null;

    // ===================================================================
    // T-SPEC §3: PCA MAPPING MATRIX (Macro → Micro)
    // ===================================================================

    /**
     * Converts 3 perceptual macro axes into 10 engineering parameters.
     * Includes input sanitization and output clamping per T-Spec §6.
     *
     * @param {number|string} clarity  - Разборчивость (0..100)
     * @param {number|string} warmth   - Бархат (0..100)
     * @param {number|string} vocalAge - Износ связок (-100..100)
     * @returns {Object} Validated payload for POST /process/{id}
     */
    function calculateMicroParams(clarity, warmth, vocalAge) {
        // 1. Input Sanitization & Clamping (§6: protects against NaN/injection)
        const C = Math.max(0, Math.min(100, Number(clarity) || 0));
        const W = Math.max(0, Math.min(100, Number(warmth) || 0));
        const A = Math.max(-100, Math.min(100, Number(vocalAge) || 0));

        // 2. Axis 1: Clarity (Разборчивость)
        const f2_shift = Math.min(200.0, C * 2.0);
        const presence_db = Math.min(6.0, C * 0.06);
        const deesser_amount = Math.min(50.0, C * 0.5);

        // 3. Axis 2: Warmth (Бархат)
        const formant_ratio = Math.max(0.85, 1.0 - (W * 0.0015));
        const pitch_ratio = Math.max(0.95, 1.0 - (W * 0.0005));
        const compression = Math.min(80.0, 50.0 + (W * 0.3));
        const noise_gate_db = Math.min(-50.0, -60.0 + (W * 0.1));

        // 4. Axis 3: Vocal Age (Износ связок)
        const jitter_mod = Math.max(-1.0, Math.min(1.0, A * 0.01));
        const breathiness_mod = A > 0 ? Math.min(60.0, A * 0.6) : 0.0;

        // 5. Build deterministic payload (toFixed to prevent float noise)
        return {
            basic: {
                pitch_ratio: Number(pitch_ratio.toFixed(3)),
                formant_ratio: Number(formant_ratio.toFixed(3)),
                presence_db: Number(presence_db.toFixed(1)),
                compression_level: Number((compression / 100.0).toFixed(3)) // backend expects 0..1
            },
            advanced: {
                f1_shift: 0.0,
                f2_shift: Number(f2_shift.toFixed(1)),
                jitter_mod: Number(jitter_mod.toFixed(3)),
                breathiness_mod: Number((breathiness_mod / 100.0).toFixed(3)), // backend expects 0..1
                noise_gate_db: Number(noise_gate_db.toFixed(1)),
                deesser_amount: Number(deesser_amount.toFixed(1))
            }
        };
    }

    // ===================================================================
    // PRO SLIDER → PHYSICAL VALUE CONVERTERS
    // ===================================================================

    /** Pitch: Log scale. Slider 0..100 → 0.5..2.0 */
    function mapPitchRatio(v) { return 0.5 * Math.pow(2.0, v / 100.0); }
    /** Reverse: physical pitch_ratio → slider 0..100 */
    function unmapPitchRatio(r) { return Math.log2(r / 0.5) * 100.0; }

    /** Formant: Linear. Slider 0..100 → 0.8..1.2 */
    function mapFormantRatio(v) { return 0.8 + (v / 100.0) * 0.4; }
    /** Reverse */
    function unmapFormantRatio(r) { return ((r - 0.8) / 0.4) * 100.0; }

    /** Jitter: Slider -100..100 → -1.0..1.0 */
    function mapJitter(v) { return v / 100.0; }

    // ===================================================================
    // DISPLAY SYNCHRONIZATION
    // ===================================================================

    function updateMacroDisplays() {
        macroDisplays.clarity.textContent = macroSliders.clarity.value + '%';
        macroDisplays.warmth.textContent = macroSliders.warmth.value + '%';
        macroDisplays.age.textContent = macroSliders.age.value;
    }

    function updateProDisplays() {
        proDisplays.pitch_ratio.textContent = mapPitchRatio(parseInt(proSliders.pitch_ratio.value)).toFixed(2);
        proDisplays.formant_ratio.textContent = mapFormantRatio(parseInt(proSliders.formant_ratio.value)).toFixed(2);
        proDisplays.presence_db.textContent = parseFloat(proSliders.presence_db.value).toFixed(1) + ' dB';
        proDisplays.compression_level.textContent = proSliders.compression_level.value;
        proDisplays.f2_shift.textContent = proSliders.f2_shift.value + ' Hz';
        proDisplays.jitter_mod.textContent = mapJitter(parseInt(proSliders.jitter_mod.value)).toFixed(2);
        proDisplays.breathiness_mod.textContent = proSliders.breathiness_mod.value + '%';
        const gateVal = parseInt(proSliders.noise_gate_db.value);
        proDisplays.noise_gate_db.textContent = gateVal <= -100 ? 'OFF' : gateVal + ' dB';
        proDisplays.deesser_amount.textContent = proSliders.deesser_amount.value + '%';
    }

    /**
     * T-Spec §2 step 2: Sync macro → pro sliders (one-way).
     * Physically updates hidden Pro slider DOM values so the payload is correct.
     */
    function syncProSlidersFromMacro() {
        const params = calculateMicroParams(
            macroSliders.clarity.value,
            macroSliders.warmth.value,
            macroSliders.age.value
        );

        // Map physical values back to slider positions
        proSliders.pitch_ratio.value = Math.round(unmapPitchRatio(params.basic.pitch_ratio));
        proSliders.formant_ratio.value = Math.round(unmapFormantRatio(params.basic.formant_ratio));
        proSliders.presence_db.value = params.basic.presence_db;
        proSliders.compression_level.value = Math.round(params.basic.compression_level * 100); // 0..1 → 0..100

        proSliders.f2_shift.value = params.advanced.f2_shift;
        proSliders.jitter_mod.value = Math.round(params.advanced.jitter_mod * 100); // -1..1 → -100..100
        proSliders.breathiness_mod.value = Math.round(params.advanced.breathiness_mod * 100); // 0..1 → 0..100
        proSliders.noise_gate_db.value = params.advanced.noise_gate_db;
        proSliders.deesser_amount.value = params.advanced.deesser_amount;

        updateProDisplays();
    }

    // ===================================================================
    // MODE TOGGLE (Simple ↔ Pro)
    // ===================================================================

    togglePro.addEventListener('change', () => {
        if (togglePro.checked) {
            uiMode = 'pro';
            simpleControls.classList.add('hidden');
            proControls.classList.remove('hidden');
            labelSimple.classList.remove('active');
            labelPro.classList.add('active');
        } else {
            uiMode = 'simple';
            proControls.classList.add('hidden');
            simpleControls.classList.remove('hidden');
            labelPro.classList.remove('active');
            labelSimple.classList.add('active');
            // Reset macro disconnection when returning to Simple
            macroDisconnected = false;
        }
    });

    // ===================================================================
    // UPLOAD LOGIC
    // ===================================================================

    const preventDefaults = (e) => { e.preventDefault(); e.stopPropagation(); };

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
        dropArea.addEventListener(ev, preventDefaults, false);
    });
    ['dragenter', 'dragover'].forEach(ev => {
        dropArea.addEventListener(ev, () => dropArea.classList.add('drag-active'), false);
    });
    ['dragleave', 'drop'].forEach(ev => {
        dropArea.addEventListener(ev, () => dropArea.classList.remove('drag-active'), false);
    });

    dropArea.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length) handleFiles(files[0]);
    }, false);

    dropArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', function() {
        if (this.files.length) handleFiles(this.files[0]);
    });

    async function handleFiles(file) {
        if (!file.name.toLowerCase().endsWith('.wav')) {
            alert('Please upload a WAV file.');
            return;
        }

        uploadLoader.classList.remove('hidden');
        const formData = new FormData();
        formData.append('file', file);

        try {
            const res = await fetch('/upload', { method: 'POST', body: formData });
            if (res.ok || res.status === 206) {
                const data = await res.json();
                fileId = data.file_id;
                statusBar.textContent = res.status === 206 ? 'Audio truncated to 15s.' : 'Ready to edit.';

                // Render baseline metrics in Pro mode (T-Spec 3)
                if (data.metrics) {
                    renderBaselines(data.metrics);
                }

                await triggerProcessing();
                uploadPanel.classList.add('hidden');
                editorPanel.classList.remove('hidden');
                initVisualizer();
            } else {
                const err = await res.json();
                alert(`Error: ${err.detail}`);
            }
        } catch (error) {
            console.error('Upload failed', error);
            alert('Host connection failed.');
        } finally {
            uploadLoader.classList.add('hidden');
        }
    }

    /**
     * Render baseline acoustic metrics into Pro mode DOM elements.
     * §5 Fault Tolerance: null → 'N/A', negative HNR → 'Unvoiced'
     */
    function renderBaselines(m) {
        const fmt = (v, unit, decimals = 1) => {
            if (v === null || v === undefined) return 'N/A';
            return Number(v).toFixed(decimals) + (unit || '');
        };

        const el = (id) => document.getElementById(id);

        // Pitch
        if (m.pitch_hz === null) {
            el('baseline-pitch').textContent = 'Original: N/A';
        } else {
            el('baseline-pitch').textContent = `Original: ${fmt(m.pitch_hz, ' Hz')}`;
        }

        // F1 / F2 under Formant Ratio
        el('baseline-f1').textContent = `F1: ${fmt(m.f1_hz, ' Hz')}`;
        el('baseline-f2').textContent = `F2: ${fmt(m.f2_hz, ' Hz')}`;

        // HF Energy under Presence
        el('baseline-hf').textContent = `HF Energy: ${fmt(m.hf_energy_ratio, '', 3)}`;

        // Crest Factor under Compression
        el('baseline-crest').textContent = `Crest Factor: ${fmt(m.crest_factor_db, ' dB')}`;

        // F2 absolute under F2 Shift
        el('baseline-f2-abs').textContent = `Original F2: ${fmt(m.f2_hz, ' Hz')}`;

        // Jitter
        if (m.jitter_pct === null) {
            el('baseline-jitter').textContent = m.hnr_db !== null && m.hnr_db < 0
                ? 'Original: Unvoiced'
                : 'Original: N/A';
        } else {
            el('baseline-jitter').textContent = `Original: ${fmt(m.jitter_pct, '%', 2)}`;
        }

        // HNR under Breathiness
        if (m.hnr_db === null) {
            el('baseline-hnr').textContent = 'HNR: N/A';
        } else {
            el('baseline-hnr').textContent = `HNR: ${fmt(m.hnr_db, ' dB')}`;
        }

        // Noise Floor
        el('baseline-noise-floor').textContent = `Noise Floor: ${fmt(m.noise_floor_db, ' dB')}`;

        // Sibilance Peak
        el('baseline-sibilance').textContent = `Peak Sibilance: ${fmt(m.sibilance_peak_db, ' dB')}`;
    }

    // ===================================================================
    // PAYLOAD BUILDER & DSP TRIGGER
    // ===================================================================

    /**
     * Build the JSON payload from current slider state.
     * In Simple mode: uses PCA mapper from macro sliders.
     * In Pro mode: reads engineering sliders directly.
     * Always sends both basic + advanced keys (backend is mode-agnostic).
     */
    function buildPayload() {
        if (uiMode === 'simple' && !macroDisconnected) {
            // PCA mapping path
            return calculateMicroParams(
                macroSliders.clarity.value,
                macroSliders.warmth.value,
                macroSliders.age.value
            );
        }

        // Pro mode / disconnected: read raw slider values
        return {
            basic: {
                pitch_ratio: mapPitchRatio(parseInt(proSliders.pitch_ratio.value)),
                formant_ratio: mapFormantRatio(parseInt(proSliders.formant_ratio.value)),
                presence_db: parseFloat(proSliders.presence_db.value),
                compression_level: parseFloat(proSliders.compression_level.value) / 100.0 // slider 0..100 → 0..1
            },
            advanced: {
                f1_shift: 0.0,
                f2_shift: parseFloat(proSliders.f2_shift.value),
                jitter_mod: mapJitter(parseInt(proSliders.jitter_mod.value)),
                breathiness_mod: parseFloat(proSliders.breathiness_mod.value) / 100.0,
                noise_gate_db: parseFloat(proSliders.noise_gate_db.value),
                deesser_amount: parseFloat(proSliders.deesser_amount.value)
            }
        };
    }

    let timer;
    let currentAbortController = null;

    const processAudio = async () => {
        // Cancel any in-flight request before starting a new one
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }

        if (isProcessing) { pendingRequest = true; return; }

        statusBar.textContent = uiMode === 'simple' ? 'Processing...' : 'Processing Pro DSP...';
        statusBar.style.color = 'var(--accent-glow)';
        isProcessing = true;

        const payload = buildPayload();

        // §6: NaN guard — block POST if payload contains NaN
        const payloadStr = JSON.stringify(payload);
        if (payloadStr.includes('null') || payloadStr.includes('NaN')) {
            statusBar.textContent = 'Error: Invalid parameter detected. Resetting.';
            statusBar.style.color = '#ff4444';
            isProcessing = false;
            return;
        }

        // Create AbortController for this request
        const abortController = new AbortController();
        currentAbortController = abortController;

        try {
            const res = await fetch(`/process/${fileId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payloadStr,
                signal: abortController.signal
            });

            if (res.status === 408) {
                statusBar.textContent = 'Error: Processing Timeout.';
                statusBar.style.color = '#ff4444';
                return;
            }
            if (res.status === 429) {
                // Server is still processing previous request — retry after short delay
                statusBar.textContent = 'Server busy, retrying...';
                statusBar.style.color = '#ffaa00';
                isProcessing = false;
                currentAbortController = null;
                setTimeout(() => triggerProcessing(), 500);
                return;
            }
            if (res.status === 422) {
                const err = await res.json();
                // Show full validation detail (could be Pydantic or DSP)
                const detail = typeof err.detail === 'string'
                    ? err.detail
                    : JSON.stringify(err.detail);
                statusBar.textContent = `Validation Error: ${detail}`;
                statusBar.style.color = '#ff4444';
                console.error('422 Payload:', payloadStr, 'Response:', err);
                return;
            }
            if (!res.ok) throw new Error(await res.text());

            const blob = await res.blob();
            if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
            currentBlobUrl = URL.createObjectURL(blob);
            audioPlayer.src = currentBlobUrl;

            if (res.headers.has('X-Processing-Warning')) {
                statusBar.textContent = 'Warning: Timeout fallback — original audio.';
                statusBar.style.color = '#ffaa00';
            } else {
                statusBar.textContent = 'Processing Complete.';
                statusBar.style.color = '#00ffcc';
            }
            drawWaveformProxy();

        } catch (e) {
            if (e.name === 'AbortError') {
                // Request was cancelled — this is intentional, not an error
                return;
            }
            console.error(e);
            statusBar.textContent = 'Error during processing.';
            statusBar.style.color = 'red';
        } finally {
            if (currentAbortController === abortController) {
                currentAbortController = null;
            }
            isProcessing = false;
            if (pendingRequest) {
                pendingRequest = false;
                triggerProcessing();
            } else {
                setTimeout(() => {
                    if (!isProcessing) {
                        statusBar.style.color = 'var(--accent-vibrant)';
                        statusBar.textContent = 'DSP Engine Idle.';
                    }
                }, 2000);
            }
        }
    };

    // §5: Debounce 250ms
    const triggerProcessing = () => {
        clearTimeout(timer);
        timer = setTimeout(processAudio, 250);
    };

    // ===================================================================
    // SLIDER EVENT WIRING
    // ===================================================================

    // Macro sliders → PCA sync → trigger DSP
    Object.keys(macroSliders).forEach(key => {
        macroSliders[key].addEventListener('input', () => {
            updateMacroDisplays();
            syncProSlidersFromMacro(); // One-way: macro → pro
            triggerProcessing();
        });
    });

    // Pro sliders → disconnect macro → trigger DSP (§2 step 5)
    Object.keys(proSliders).forEach(key => {
        proSliders[key].addEventListener('input', () => {
            macroDisconnected = true;
            // Reset macro sliders to default to show disconnection
            macroSliders.clarity.value = 0;
            macroSliders.warmth.value = 0;
            macroSliders.age.value = 0;
            updateMacroDisplays();
            updateProDisplays();
            triggerProcessing();
        });
    });

    // Init
    updateMacroDisplays();
    syncProSlidersFromMacro();

    // ===================================================================
    // PLAYBACK & VISUALIZER
    // ===================================================================

    function formatTime(secs) {
        if (isNaN(secs)) return '00:00';
        const mins = Math.floor(secs / 60);
        const ss = Math.floor(secs % 60);
        return `${mins.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
    }

    btnPlay.addEventListener('click', () => {
        if (audioPlayer.paused) {
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
            audioPlayer.play();
            btnPlay.classList.add('playing');
        } else {
            audioPlayer.pause();
            btnPlay.classList.remove('playing');
        }
    });

    audioPlayer.addEventListener('timeupdate', () => {
        timeDisplay.textContent = `${formatTime(audioPlayer.currentTime)} / ${formatTime(audioPlayer.duration)}`;
        drawWaveformProxy(audioPlayer.currentTime / audioPlayer.duration);
    });

    audioPlayer.addEventListener('ended', () => {
        btnPlay.classList.remove('playing');
        drawWaveformProxy(0);
        audioPlayer.currentTime = 0;
    });

    function initVisualizer() {
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;
        drawWaveformProxy(0);
        window.addEventListener('resize', () => {
            if (canvas.offsetParent) {
                canvas.width = canvas.parentElement.clientWidth;
                canvas.height = canvas.parentElement.clientHeight;
                drawWaveformProxy(audioPlayer.currentTime / (audioPlayer.duration || 1));
            }
        });
    }

    function drawWaveformProxy(progress = 0) {
        if (!canvas.offsetParent) return;
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const barCount = 64;
        const barWidth = (w / barCount) - 2;

        for (let i = 0; i < barCount; i++) {
            let hRatio = 0.2 + (Math.sin(i * 0.4) * 0.4) + (Math.cos(i * 0.9) * 0.3) + 0.1;
            hRatio = Math.max(0.1, hRatio);
            const barH = h * hRatio * 0.8;
            const x = i * (barWidth + 2);
            const y = (h - barH) / 2;
            const isPlayed = (i / barCount) <= progress;
            ctx.fillStyle = isPlayed ? '#e020a5' : '#8a2be255';
            ctx.beginPath();
            ctx.roundRect(x, y, barWidth, barH, 4);
            ctx.fill();
        }

        if (progress > 0 && progress < 1) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(w * progress, 0, 2, h);
        }
    }

    // ===================================================================
    // EXPORT & RESET
    // ===================================================================

    btnExport.addEventListener('click', () => {
        if (!currentBlobUrl) return;
        const a = document.createElement('a');
        a.href = currentBlobUrl;
        const d = new Date();
        const ts = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
        a.download = `golden_ref_${ts}.wav`;
        a.click();
    });

    btnReset.addEventListener('click', () => {
        audioPlayer.pause();
        audioPlayer.src = '';
        currentBlobUrl = null;
        fileId = null;

        // Reset Macro
        macroSliders.clarity.value = 0;
        macroSliders.warmth.value = 0;
        macroSliders.age.value = 0;
        macroDisconnected = false;
        updateMacroDisplays();
        syncProSlidersFromMacro();

        // Reset mode to Simple
        togglePro.checked = false;
        uiMode = 'simple';
        proControls.classList.add('hidden');
        simpleControls.classList.remove('hidden');
        labelPro.classList.remove('active');
        labelSimple.classList.add('active');

        btnPlay.classList.remove('playing');
        timeDisplay.textContent = '00:00 / 00:00';
        statusBar.textContent = 'Waiting for file...';

        editorPanel.classList.add('hidden');
        uploadPanel.classList.remove('hidden');
    });
});

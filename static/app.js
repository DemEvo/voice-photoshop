document.addEventListener('DOMContentLoaded', () => {
    // ===================================================================
    // STATE
    // ===================================================================
    let fileId = null;
    let currentBlobUrl = null;
    let isProcessing = false;
    let pendingRequest = false;
    let uiMode = 'simple'; // 'simple' | 'pro'
    let macroDisconnected = false;
    let metricsCache = { source: null, reference: null }; // true when user manually edits Pro sliders

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
        pitch: document.getElementById('src-pitch'),
        f1: document.getElementById('src-f1'),
        f2: document.getElementById('src-f2'),
        hf: document.getElementById('src-hf'),
        crest: document.getElementById('src-crest'),
        sib: document.getElementById('src-sib'),
        noise: document.getElementById('src-noise'),
        hnr: document.getElementById('src-hnr'),
        jitter: document.getElementById('src-jitter')
    };
    const proDisplays = {
        pitch: document.getElementById('val-pitch'),
        f1: document.getElementById('val-f1'),
        f2: document.getElementById('val-f2'),
        hf: document.getElementById('val-hf'),
        crest: document.getElementById('val-crest'),
        sib: document.getElementById('val-sib'),
        noise: document.getElementById('val-noise'),
        hnr: document.getElementById('val-hnr'),
        jitter: document.getElementById('val-jitter')
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
    // DISPLAY SYNCHRONIZATION
    // ===================================================================

    function updateMacroDisplays() {
        macroDisplays.clarity.textContent = macroSliders.clarity.value + '%';
        macroDisplays.warmth.textContent = macroSliders.warmth.value + '%';
        macroDisplays.age.textContent = macroSliders.age.value;
    }



    /**
     * T-Spec §2 step 2: Sync macro → pro sliders (one-way).
     * Physically updates hidden Pro slider DOM values so the payload is correct.
     */
    function syncProSlidersFromMacro() { /* disabled for radial UI */ }

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

    // File 1: Source
    const dropAreaSource = document.getElementById('drop-area');
    const fileSource = document.getElementById('file-input');
    const sourceFilename = document.getElementById('source-filename');
    
    // File 2: Reference
    const dropAreaRef = document.getElementById('drop-area-ref');
    const fileRef = document.getElementById('file-input-ref');
    const refFilename = document.getElementById('ref-filename');
    const btnUpload = document.getElementById('btn-upload');

    [dropAreaSource, dropAreaRef].forEach(area => {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
            area.addEventListener(ev, preventDefaults, false);
        });
        ['dragenter', 'dragover'].forEach(ev => {
            area.addEventListener(ev, () => area.classList.add('drag-active'), false);
        });
        ['dragleave', 'drop'].forEach(ev => {
            area.addEventListener(ev, () => area.classList.remove('drag-active'), false);
        });
    });

    dropAreaSource.addEventListener('click', () => fileSource.click());
    dropAreaRef.addEventListener('click', () => fileRef.click());

    dropAreaSource.addEventListener('drop', (e) => {
        if (e.dataTransfer.files.length) {
            fileSource.files = e.dataTransfer.files;
            sourceFilename.textContent = fileSource.files[0].name;
        }
    });

    dropAreaRef.addEventListener('drop', (e) => {
        if (e.dataTransfer.files.length) {
            fileRef.files = e.dataTransfer.files;
            refFilename.textContent = fileRef.files[0].name;
        }
    });

    fileSource.addEventListener('change', () => {
        if (fileSource.files.length) sourceFilename.textContent = fileSource.files[0].name;
    });

    fileRef.addEventListener('change', () => {
        if (fileRef.files.length) refFilename.textContent = fileRef.files[0].name;
    });

    btnUpload.addEventListener('click', async () => {
        if (!fileSource.files.length) {
            alert('Source file is mandatory.');
            return;
        }

        uploadLoader.classList.remove('hidden');
        const formData = new FormData();
        formData.append('file_source', fileSource.files[0]);
        if (fileRef.files.length) {
            formData.append('file_reference', fileRef.files[0]);
        }

        try {
            const res = await fetch('/upload', { method: 'POST', body: formData });
            if (res.ok || res.status === 206) {
                const data = await res.json();
                fileId = data.file_id;
                statusBar.textContent = res.status === 206 ? 'Audio truncated to 15s.' : 'Ready to edit.';
                
                metricsCache.source = data.source_metrics;
                metricsCache.reference = data.reference_metrics;
                
                initRadialUI();

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
    });

    // ===================================================================
    // RADIAL UI INITIALIZATION (T-Spec 4)
    // ===================================================================

    function calculatePercent(value, min, max) {
        let percent = ((value - min) / (max - min)) * 100;
        return Math.max(0, Math.min(100, percent));
    }

    function initRadialUI() {
        const base = metricsCache.source || {};
        const ref = metricsCache.reference || null;

        const syncAxis = (sliderId, displayId, refId, baseVal, refVal, decimals) => {
            const slider = proSliders[sliderId];
            const display = proDisplays[displayId];
            const refMarker = document.getElementById(refId);

            if (baseVal !== undefined && baseVal !== null) {
                slider.value = baseVal;
                display.innerText = Number(baseVal).toFixed(decimals);
            }

            if (ref && refVal !== undefined && refVal !== null) {
                const pct = calculatePercent(refVal, parseFloat(slider.min), parseFloat(slider.max));
                refMarker.style.setProperty('--ref-percent', `${pct}%`);
                refMarker.style.display = 'block';
            } else {
                // §4 Single file mode: hide reference marker
                refMarker.style.display = 'none';
            }
        };

        syncAxis('pitch', 'pitch', 'ref-pitch', base.pitch_hz, ref?.pitch_hz, 0);
        syncAxis('f1', 'f1', 'ref-f1', base.f1_hz, ref?.f1_hz, 0);
        syncAxis('f2', 'f2', 'ref-f2', base.f2_hz, ref?.f2_hz, 0);
        syncAxis('hf', 'hf', 'ref-hf', base.hf_energy_ratio, ref?.hf_energy_ratio, 2);
        syncAxis('crest', 'crest', 'ref-crest', base.crest_factor_db, ref?.crest_factor_db, 1);
        syncAxis('sib', 'sib', 'ref-sib', base.sibilance_peak_db, ref?.sibilance_peak_db, 1);
        syncAxis('noise', 'noise', 'ref-noise', base.noise_floor_db, ref?.noise_floor_db, 0);
        syncAxis('hnr', 'hnr', 'ref-hnr', base.hnr_db, ref?.hnr_db, 1);
        syncAxis('jitter', 'jitter', 'ref-jitter', base.jitter_pct, ref?.jitter_pct, 2);
    }

    // Attach local input listeners for dynamic number updates
    Object.keys(proSliders).forEach(key => {
        proSliders[key].addEventListener('input', function() {
            proDisplays[key].innerText = Number(this.value).toFixed(this.step.includes('.') ? this.step.split('.')[1].length : 0);
            macroDisconnected = true;
        });
    });

    function buildPayload() {
        if (uiMode === 'simple' && !macroDisconnected) {
            return calculateMicroParams(
                macroSliders.clarity.value,
                macroSliders.warmth.value,
                macroSliders.age.value
            );
        }

        const base = metricsCache.source || {
            pitch_hz: 100.0, f1_hz: 500.0, f2_hz: 1500.0,
            presence_db: 2.0, noise_floor_db: -45.0, sibilance_peak_db: -10.0,
            crest_factor_db: 18.0, hnr_db: 15.0, jitter_pct: 1.0, hf_energy_ratio: 0.1
        };

        const currentPitchHz = parseFloat(proSliders.pitch.value);
        const currentF1Hz = parseFloat(proSliders.f1.value);
        const currentF2Hz = parseFloat(proSliders.f2.value);
        const currentHf = parseFloat(proSliders.hf.value);
        const currentCrest = parseFloat(proSliders.crest.value);
        const currentSib = parseFloat(proSliders.sib.value);
        const currentNoise = parseFloat(proSliders.noise.value);
        const currentHnr = parseFloat(proSliders.hnr.value);
        const currentJitter = parseFloat(proSliders.jitter.value);

        // A. Frequencies (Ratio)
        let pitchRatio = base.pitch_hz > 0 ? (currentPitchHz / base.pitch_hz) : 1.0;
        let formantRatio = base.f1_hz > 0 ? (currentF1Hz / base.f1_hz) : 1.0;
        pitchRatio = Math.max(0.5, Math.min(2.0, pitchRatio));
        formantRatio = Math.max(0.7, Math.min(1.3, formantRatio));

        // B. Deltas
        let f2ShiftDelta = currentF2Hz - base.f2_hz;
        
        // Presence mapping (HF diff -> dB boost approximation)
        let presenceDelta = (currentHf - base.hf_energy_ratio) * 20.0;
        presenceDelta = Math.max(0.0, Math.min(10.0, presenceDelta));

        // Compression (Crest Factor delta -> compression level 0-1)
        // lower crest = more compression.
        let crestDelta = base.crest_factor_db - currentCrest;
        let compression = Math.max(0.0, Math.min(1.0, crestDelta * 0.05));

        // DeEsser (Sibilance delta)
        let deesserAmount = base.sibilance_peak_db - currentSib;
        deesserAmount = Math.max(0.0, Math.min(100.0, deesserAmount * 5.0));

        // Jitter Mod (absolute delta)
        let jitterMod = currentJitter - base.jitter_pct;
        jitterMod = Math.max(-1.0, Math.min(1.0, jitterMod));

        // Breathiness (HNR delta: lower HNR = more breathiness)
        let breathinessMod = (base.hnr_db - currentHnr) * 0.05;
        breathinessMod = Math.max(0.0, Math.min(1.0, breathinessMod));

        return {
            basic: {
                pitch_ratio: Number(pitchRatio.toFixed(3)),
                formant_ratio: Number(formantRatio.toFixed(3)),
                presence_db: Number(presenceDelta.toFixed(1)),
                compression_level: Number(compression.toFixed(3))
            },
            advanced: {
                f1_shift: 0.0,
                f2_shift: Number(f2ShiftDelta.toFixed(1)),
                jitter_mod: Number(jitterMod.toFixed(3)),
                breathiness_mod: Number(breathinessMod.toFixed(3)),
                noise_gate_db: Number(currentNoise.toFixed(1)),
                deesser_amount: Number(deesserAmount.toFixed(1))
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
            syncProSlidersFromMacro(); // One-way: macro → pro (disabled in full radial but kept for structure)
            triggerProcessing();
        });
    });

    // Pro sliders → disconnect macro → trigger DSP (§2 step 5)
    Object.keys(proSliders).forEach(key => {
        proSliders[key].addEventListener('change', () => {
            macroDisconnected = true;
            
            // Reset macro sliders to default to visualize disconnection
            macroSliders.clarity.value = 0;
            macroSliders.warmth.value = 0;
            macroSliders.age.value = 0;
            updateMacroDisplays();
            
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

document.addEventListener('DOMContentLoaded', () => {
    // State
    let fileId = null;
    let currentBlobUrl = null;
    let isProcessing = false;
    let pendingRequest = false;
    let advancedMode = false;

    // Elements
    const uploadPanel = document.getElementById('upload-panel');
    const editorPanel = document.getElementById('editor-panel');
    const dropArea = document.getElementById('drop-area');
    const fileInput = document.getElementById('file-input');
    const uploadLoader = document.getElementById('upload-loader');
    const toggleAdvanced = document.getElementById('toggle-advanced');
    const advancedControls = document.getElementById('advanced-controls');

    // Basic Sliders
    const basicSliders = {
        pitch_ratio: document.getElementById('pitch_ratio'),
        formant_ratio: document.getElementById('formant_ratio'),
        presence_db: document.getElementById('presence_db'),
        compression_level: document.getElementById('compression_level')
    };

    const basicDisplays = {
        pitch_ratio: document.getElementById('val-pitch'),
        formant_ratio: document.getElementById('val-formant'),
        presence_db: document.getElementById('val-presence'),
        compression_level: document.getElementById('val-comp')
    };

    // Advanced Sliders
    const advSliders = {
        f2_shift: document.getElementById('f2_shift'),
        jitter_mod: document.getElementById('jitter_mod'),
        breathiness_mod: document.getElementById('breathiness_mod'),
        noise_gate_db: document.getElementById('noise_gate_db'),
        deesser_amount: document.getElementById('deesser_amount')
    };

    const advDisplays = {
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

    // Visualizer Canvas
    const canvas = document.getElementById('waveform-canvas');
    const ctx = canvas.getContext('2d');
    let audioCtx = null;

    // -----------------------------------------------------------
    // MAPPING FUNCTIONS (T-Spec §4)
    // -----------------------------------------------------------

    /**
     * Pitch: Log scale mapping.
     * Slider 0..100 → pitch_ratio 0.5..2.0
     * Using exponential/log mapping: ratio = 0.5 * 2^(slider/100)
     * At slider=0 → 0.5, slider=50 → ~1.0, slider=100 → 2.0
     */
    function mapPitchRatio(sliderVal) {
        return 0.5 * Math.pow(2.0, sliderVal / 100.0);
    }

    /**
     * Formant: Linear scale mapping.
     * Slider 0..100 → formant_ratio 0.8..1.2
     */
    function mapFormantRatio(sliderVal) {
        return 0.8 + (sliderVal / 100.0) * 0.4;
    }

    /**
     * Jitter: Linear mapping.
     * Slider -100..100 → jitter_mod -1.0..1.0
     */
    function mapJitter(sliderVal) {
        return sliderVal / 100.0;
    }

    // -----------------------------------------------------------
    // DISPLAY UPDATE
    // -----------------------------------------------------------

    function updateBasicDisplays() {
        const pRatio = mapPitchRatio(parseInt(basicSliders.pitch_ratio.value));
        basicDisplays.pitch_ratio.textContent = pRatio.toFixed(2);

        const fRatio = mapFormantRatio(parseInt(basicSliders.formant_ratio.value));
        basicDisplays.formant_ratio.textContent = fRatio.toFixed(2);

        basicDisplays.presence_db.textContent = parseFloat(basicSliders.presence_db.value).toFixed(1) + ' dB';
        basicDisplays.compression_level.textContent = parseFloat(basicSliders.compression_level.value).toFixed(2);
    }

    function updateAdvDisplays() {
        advDisplays.f2_shift.textContent = advSliders.f2_shift.value + ' Hz';
        advDisplays.jitter_mod.textContent = mapJitter(parseInt(advSliders.jitter_mod.value)).toFixed(2);
        advDisplays.breathiness_mod.textContent = advSliders.breathiness_mod.value + '%';

        const gateVal = parseInt(advSliders.noise_gate_db.value);
        advDisplays.noise_gate_db.textContent = gateVal <= -100 ? 'OFF' : gateVal + ' dB';

        advDisplays.deesser_amount.textContent = advSliders.deesser_amount.value + '%';
    }

    // -----------------------------------------------------------
    // ADVANCED MODE TOGGLE
    // -----------------------------------------------------------

    toggleAdvanced.addEventListener('change', () => {
        advancedMode = toggleAdvanced.checked;
        if (advancedMode) {
            advancedControls.classList.remove('hidden');
        } else {
            advancedControls.classList.add('hidden');
        }
        triggerProcessing();
    });

    // -----------------------------------------------------------
    // UPLOAD LOGIC
    // -----------------------------------------------------------
    const preventDefaults = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
        dropArea.addEventListener(ev, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach(ev => {
        dropArea.addEventListener(ev, () => {
            dropArea.classList.add('drag-active');
        }, false);
    });

    ['dragleave', 'drop'].forEach(ev => {
        dropArea.addEventListener(ev, () => {
            dropArea.classList.remove('drag-active');
        }, false);
    });

    dropArea.addEventListener('drop', (e) => {
        let dt = e.dataTransfer;
        let files = dt.files;
        if (files.length) handleFiles(files[0]);
    }, false);

    dropArea.addEventListener('click', () => {
        fileInput.click();
    });

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
            const res = await fetch('/upload', {
                method: 'POST',
                body: formData
            });

            if (res.ok || res.status === 206) {
                const data = await res.json();
                fileId = data.file_id;

                if (res.status === 206) {
                    statusBar.textContent = 'Audio truncated to 15s.';
                } else {
                    statusBar.textContent = 'Ready to edit.';
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

    // -----------------------------------------------------------
    // DSP & CONTROLS
    // -----------------------------------------------------------

    let timer;
    const processAudio = async () => {
        if (isProcessing) {
            pendingRequest = true;
            return;
        }

        statusBar.textContent = advancedMode ? 'Processing Advanced DSP...' : 'Processing DSP Engine...';
        statusBar.style.color = 'var(--accent-glow)';
        isProcessing = true;

        // Build payload with mapped values
        const payload = {
            basic: {
                pitch_ratio: mapPitchRatio(parseInt(basicSliders.pitch_ratio.value)),
                formant_ratio: mapFormantRatio(parseInt(basicSliders.formant_ratio.value)),
                presence_db: parseFloat(basicSliders.presence_db.value),
                compression_level: parseFloat(basicSliders.compression_level.value)
            }
        };

        if (advancedMode) {
            payload.advanced = {
                f1_shift: 0.0,  // Protected, always 0
                f2_shift: parseFloat(advSliders.f2_shift.value),
                jitter_mod: mapJitter(parseInt(advSliders.jitter_mod.value)),
                breathiness_mod: parseFloat(advSliders.breathiness_mod.value) / 100.0,
                noise_gate_db: parseFloat(advSliders.noise_gate_db.value),
                deesser_amount: parseFloat(advSliders.deesser_amount.value)
            };
        }

        try {
            const res = await fetch(`/process/${fileId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.status === 408) {
                statusBar.textContent = 'Error: Processing Timeout (> 4s).';
                statusBar.style.color = '#ff4444';
                return;
            }
            if (res.status === 422) {
                const err = await res.json();
                statusBar.textContent = `DSP Error: ${err.detail}`;
                statusBar.style.color = '#ff4444';
                return;
            }
            if (!res.ok) throw new Error(await res.text());

            const blob = await res.blob();

            if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
            currentBlobUrl = URL.createObjectURL(blob);
            audioPlayer.src = currentBlobUrl;

            if (res.headers.has('X-Processing-Warning')) {
                statusBar.textContent = 'Warning: Processor Timeout (Original Audio Fallback).';
                statusBar.style.color = '#ffaa00';
            } else {
                statusBar.textContent = 'Processing Complete.';
                statusBar.style.color = '#00ffcc';
            }

            drawWaveformProxy();

        } catch (e) {
            console.error(e);
            statusBar.textContent = 'Error during processing.';
            statusBar.style.color = 'red';
        } finally {
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

    const triggerProcessing = () => {
        clearTimeout(timer);
        timer = setTimeout(processAudio, 400);
    };

    // Basic slider listeners
    Object.keys(basicSliders).forEach(key => {
        basicSliders[key].addEventListener('input', () => {
            updateBasicDisplays();
            triggerProcessing();
        });
    });

    // Advanced slider listeners
    Object.keys(advSliders).forEach(key => {
        advSliders[key].addEventListener('input', () => {
            updateAdvDisplays();
            triggerProcessing();
        });
    });

    // Init display values
    updateBasicDisplays();
    updateAdvDisplays();

    // -----------------------------------------------------------
    // PLAYBACK AND VISUALIZER
    // -----------------------------------------------------------

    function formatTime(secs) {
        if (isNaN(secs)) return '00:00';
        let mins = Math.floor(secs / 60);
        let ss = Math.floor(secs % 60);
        return `${mins.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
    }

    btnPlay.addEventListener('click', () => {
        if (audioPlayer.paused) {
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
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
            if(canvas.offsetParent) {
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
        ctx.clearRect(0,0,w,h);

        const barCount = 64;
        const barWidth = (w / barCount) - 2;

        for (let i = 0; i < barCount; i++) {
            let hRatio = 0.2 + (Math.sin(i * 0.4) * 0.4) + (Math.cos(i * 0.9) * 0.3) + 0.1;
            hRatio = Math.max(0.1, hRatio);
            let barH = h * hRatio * 0.8;

            let x = i * (barWidth + 2);
            let y = (h - barH) / 2;

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

    // -----------------------------------------------------------
    // EXPORT & APP RESET
    // -----------------------------------------------------------
    btnExport.addEventListener('click', () => {
        if (!currentBlobUrl) return;
        const a = document.createElement('a');
        a.href = currentBlobUrl;

        const d = new Date();
        const timestamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
        a.download = `golden_ref_${timestamp}.wav`;
        a.click();
    });

    btnReset.addEventListener('click', () => {
        audioPlayer.pause();
        audioPlayer.src = '';
        currentBlobUrl = null;
        fileId = null;

        // Reset Basic Sliders
        basicSliders.pitch_ratio.value = "50";
        basicSliders.formant_ratio.value = "50";
        basicSliders.presence_db.value = "0";
        basicSliders.compression_level.value = "0";
        updateBasicDisplays();

        // Reset Advanced Sliders
        advSliders.f2_shift.value = "0";
        advSliders.jitter_mod.value = "0";
        advSliders.breathiness_mod.value = "0";
        advSliders.noise_gate_db.value = "-100";
        advSliders.deesser_amount.value = "0";
        updateAdvDisplays();

        // Reset mode
        toggleAdvanced.checked = false;
        advancedMode = false;
        advancedControls.classList.add('hidden');

        btnPlay.classList.remove('playing');
        timeDisplay.textContent = '00:00 / 00:00';
        statusBar.textContent = 'Waiting for file...';

        editorPanel.classList.add('hidden');
        uploadPanel.classList.remove('hidden');
    });
});

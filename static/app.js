document.addEventListener('DOMContentLoaded', () => {
    // State
    let fileId = null;
    let currentBlobUrl = null;
    let isProcessing = false;
    let pendingRequest = false;

    // Elements
    const uploadPanel = document.getElementById('upload-panel');
    const editorPanel = document.getElementById('editor-panel');
    const dropArea = document.getElementById('drop-area');
    const fileInput = document.getElementById('file-input');
    const uploadLoader = document.getElementById('upload-loader');
    
    // Controls
    const sliders = {
        pitch_ratio: document.getElementById('pitch_ratio'),
        formant_ratio: document.getElementById('formant_ratio'),
        presence_db: document.getElementById('presence_db'),
        compression_level: document.getElementById('compression_level')
    };
    
    const displays = {
        pitch_ratio: document.getElementById('val-pitch'),
        formant_ratio: document.getElementById('val-formant'),
        presence_db: document.getElementById('val-presence'),
        compression_level: document.getElementById('val-comp')
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

    // -------------------------------------------------------------
    // UPLOAD LOGIC
    // -------------------------------------------------------------
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
                
                // Init audio rendering
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

    // -------------------------------------------------------------
    // DSP & CONTROLS
    // -------------------------------------------------------------
    
    // Simple Debounce
    let timer;
    const processAudio = async () => {
        if (isProcessing) {
            pendingRequest = true;
            return;
        }

        statusBar.textContent = 'Processing DSP Engine...';
        statusBar.style.color = 'var(--accent-glow)';
        isProcessing = true;

        const payload = {
            pitch_ratio: parseFloat(sliders.pitch_ratio.value),
            formant_ratio: parseFloat(sliders.formant_ratio.value),
            presence_db: parseFloat(sliders.presence_db.value),
            compression_level: parseFloat(sliders.compression_level.value)
        };

        try {
            const res = await fetch(`/process/${fileId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error(await res.text());

            const blob = await res.blob();
            
            // Re-assign player
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

            // Auto-play if it was playing? 
            // Usually bad for UX, let them press play.

        } catch (e) {
            console.error(e);
            statusBar.textContent = 'Error during processing.';
            statusBar.style.color = 'red';
        } finally {
            isProcessing = false;
            if (pendingRequest) {
                pendingRequest = false;
                triggerProcessing(); // loop back any pending slider updates
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
        timer = setTimeout(processAudio, 400); // 400ms debounce
    };

    // Update UI on input
    Object.keys(sliders).forEach(key => {
        sliders[key].addEventListener('input', (e) => {
            let val = e.target.value;
            if (key === 'presence_db') val += ' dB';
            displays[key].textContent = val;
            triggerProcessing();
        });
    });

    // -------------------------------------------------------------
    // PLAYBACK AND VISUALIZER
    // -------------------------------------------------------------

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

    // Dummy visualization for aesthetics
    function initVisualizer() {
        // Just resize internal config
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
        if (!canvas.offsetParent) return; // Hidden
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0,0,w,h);
        
        const barCount = 64;
        const barWidth = (w / barCount) - 2;
        
        for (let i = 0; i < barCount; i++) {
            // Generate deterministic pseudo-random heights for aesthetic
            // Base aesthetic on fileId hash equivalent or simple seed
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
        
        // Playhead
        if (progress > 0 && progress < 1) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(w * progress, 0, 2, h);
        }
    }

    // -------------------------------------------------------------
    // EXPORT & APP RESET
    // -------------------------------------------------------------
    btnExport.addEventListener('click', () => {
        if (!currentBlobUrl) return;
        const a = document.createElement('a');
        a.href = currentBlobUrl;
        
        const d = new Date();
        const timestamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
        // Output convention: golden_ref_[timestamp].wav
        a.download = `golden_ref_${timestamp}.wav`;
        a.click();
    });

    btnReset.addEventListener('click', () => {
        audioPlayer.pause();
        audioPlayer.src = '';
        currentBlobUrl = null;
        fileId = null;
        
        // Reset Sliders
        sliders.pitch_ratio.value = "1.0";
        sliders.formant_ratio.value = "1.0";
        sliders.presence_db.value = "0";
        sliders.compression_level.value = "0";
        Object.keys(sliders).forEach(k => {
            displays[k].textContent = k === 'presence_db' ? '0 dB' : (k.includes('ratio') ? '1.0' : '0.0');
        });
        
        // UI State
        btnPlay.classList.remove('playing');
        timeDisplay.textContent = '00:00 / 00:00';
        statusBar.textContent = 'Waiting for file...';
        
        editorPanel.classList.add('hidden');
        uploadPanel.classList.remove('hidden');
    });
});

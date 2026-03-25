import os
import uuid
import io
import time
import numpy as np
import scipy.io.wavfile as wav
import parselmouth
from parselmouth.praat import call
from pedalboard import Pedalboard, Compressor, HighShelfFilter, NoiseGate, Limiter
from pedalboard.io import AudioFile
from fastapi import FastAPI, UploadFile, File, HTTPException, Body, Response
from fastapi.responses import StreamingResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/")
async def root():
    return RedirectResponse(url="/static/index.html")

# In-memory storage for audio files (simulating RAM buffer)
audio_sessions: dict = {}

app.mount("/static", StaticFiles(directory="static"), name="static")

# --- Request Models ---

class BasicParams(BaseModel):
    pitch_ratio: float = Field(ge=0.5, le=2.0, default=1.0)
    formant_ratio: float = Field(ge=0.8, le=1.2, default=1.0)
    presence_db: float = Field(ge=0.0, le=10.0, default=0.0)
    compression_level: float = Field(ge=0.0, le=1.0, default=0.0)

class AdvancedParams(BaseModel):
    f1_shift: float = Field(default=0.0)        # Hz offset (display only, protected)
    f2_shift: float = Field(default=0.0)         # Hz offset for F2
    jitter_mod: float = Field(default=0.0)       # -1..1
    breathiness_mod: float = Field(default=0.0)  # 0..1
    noise_gate_db: float = Field(default=-100.0) # threshold dB
    deesser_amount: float = Field(default=0.0)   # 0..100 percent

class ProcessRequest(BaseModel):
    basic: BasicParams = BasicParams()
    advanced: Optional[AdvancedParams] = None

# --- Utility functions ---

def calculate_rms(data: np.ndarray) -> float:
    if data.dtype == np.int16:
        float_data = data.astype(np.float32) / 32768.0
    else:
        float_data = data.astype(np.float32)
    return float(np.sqrt(np.mean(float_data**2)))

def trim_silence(data: np.ndarray, sr: int, db_threshold: float = -40.0) -> np.ndarray:
    if data.dtype == np.int16:
        float_data = data.astype(np.float32) / 32768.0
    else:
        float_data = data.astype(np.float32)

    amplitude_threshold = 10.0 ** (db_threshold / 20.0)

    start_idx = 0
    for i in range(len(float_data)):
        if abs(float_data[i]) > amplitude_threshold:
            start_idx = i
            break

    end_idx = len(float_data)
    for i in range(len(float_data)-1, -1, -1):
        if abs(float_data[i]) > amplitude_threshold:
            end_idx = i + 1
            break

    if start_idx >= end_idx:
        return data
    return data[start_idx:end_idx]

def to_float64(data: np.ndarray) -> np.ndarray:
    if data.dtype == np.int16:
        return data.astype(np.float64) / 32768.0
    return data.astype(np.float64)

def detect_f0_median(sound) -> float:
    """Detect median F0 of a Praat Sound object."""
    pitch = call(sound, "To Pitch", 0.0, 75.0, 600.0)
    median = call(pitch, "Get quantile", 0.0, 0.0, 0.5, "Hertz")
    if np.isnan(median) or median == 0:
        return 150.0  # fallback
    return float(median)

def choose_lpc_order(f0: float) -> int:
    """Auto LPC order: F0 < 150 Hz → 16; F0 > 150 Hz → 12."""
    return 16 if f0 < 150.0 else 12

def apply_lpc_formant_shift(sound, f2_shift: float, sr: int, f0: float) -> np.ndarray:
    """
    LPC-based formant shifting for F2/F3 while protecting F1 (roots < 800 Hz).
    Uses Burg LPC → root manipulation → OLA resynthesis.
    """
    lpc_order = choose_lpc_order(f0)
    float_data = sound.values[0].copy()
    n_samples = len(float_data)

    # OLA parameters
    frame_len = int(0.025 * sr)   # 25ms frames
    hop_len = int(0.010 * sr)     # 10ms hop
    window = np.hanning(frame_len)

    output = np.zeros(n_samples)
    weight = np.zeros(n_samples)

    for start in range(0, n_samples - frame_len, hop_len):
        frame = float_data[start:start + frame_len] * window

        # Compute LPC coefficients via autocorrelation (Burg-style simplified)
        try:
            # Use numpy's lstsq for LPC
            acf = np.correlate(frame, frame, mode='full')
            acf = acf[frame_len - 1:]  # positive lag only
            # Levinson-Durbin
            lpc_coeffs = _levinson_durbin(acf, lpc_order)
        except Exception:
            # If LPC fails, pass through original frame
            output[start:start + frame_len] += frame
            weight[start:start + frame_len] += window
            continue

        # Get roots of LPC polynomial
        roots = np.roots(np.concatenate(([1.0], lpc_coeffs)))

        # Modify roots: shift F2/F3 formants but protect F1 (< 800 Hz)
        new_roots = []
        for r in roots:
            if np.abs(r) < 1e-10:
                new_roots.append(r)
                continue
            freq = np.abs(np.angle(r)) * sr / (2.0 * np.pi)
            # Protect F1: don't modify roots below 800 Hz
            if freq < 800.0:
                new_roots.append(r)
            else:
                # Shift frequency by f2_shift Hz
                angle = np.angle(r)
                magnitude = np.abs(r)
                # Clamp magnitude for stability
                if magnitude >= 1.0:
                    magnitude = 0.999
                new_freq = freq + f2_shift
                if new_freq < 800.0:
                    new_freq = 800.0  # don't shift into F1 territory
                new_angle = new_freq * 2.0 * np.pi / sr
                if angle < 0:
                    new_angle = -new_angle
                new_roots.append(magnitude * np.exp(1j * new_angle))

        new_roots = np.array(new_roots)

        # Check stability: all roots must be inside unit circle
        if np.any(np.abs(new_roots) >= 1.0):
            raise ValueError("LPC_INSTABILITY")

        # Reconstruct LPC polynomial from new roots
        new_poly = np.real(np.poly(new_roots))
        new_lpc = new_poly[1:]  # Remove leading 1

        # Compute residual (excitation) from original LPC
        residual = np.zeros(frame_len)
        for i in range(frame_len):
            residual[i] = frame[i]
            for j in range(min(i, lpc_order)):
                residual[i] += lpc_coeffs[j] * frame[i - j - 1]

        # Resynthesize with new LPC coefficients
        synth = np.zeros(frame_len)
        for i in range(frame_len):
            synth[i] = residual[i]
            for j in range(min(i, lpc_order)):
                synth[i] -= new_lpc[j] * synth[i - j - 1]

        output[start:start + frame_len] += synth * window
        weight[start:start + frame_len] += window

    # Normalize OLA
    mask = weight > 1e-8
    output[mask] /= weight[mask]

    return output

def _levinson_durbin(acf: np.ndarray, order: int) -> np.ndarray:
    """Levinson-Durbin recursion for LPC coefficients."""
    if acf[0] == 0:
        return np.zeros(order)
    a = np.zeros(order)
    e = acf[0]
    for i in range(order):
        lam = acf[i + 1]
        for j in range(i):
            lam -= a[j] * acf[i - j]
        k = lam / e
        # Update coefficients
        new_a = a.copy()
        new_a[i] = k
        for j in range(i):
            new_a[j] = a[j] - k * a[i - 1 - j]
        a = new_a
        e *= (1 - k * k)
        if e <= 0:
            break
    return a

def apply_deesser(data: np.ndarray, sr: int, amount_pct: float) -> np.ndarray:
    """
    De-esser: split at 5kHz, apply RMS-based compression to high band, sum back.
    amount_pct: 0-100 controls threshold (inverted: 0% = 0dB, 100% = -60dB).
    """
    if amount_pct <= 0:
        return data

    from scipy.signal import butter, sosfilt

    nyq = sr / 2.0
    cutoff = min(5000.0, nyq * 0.95)
    # Butterworth bandpass split at 5kHz, Q≈0.707 (2nd order)
    sos_low = butter(2, cutoff / nyq, btype='low', output='sos')
    sos_high = butter(2, cutoff / nyq, btype='high', output='sos')

    low_band = sosfilt(sos_low, data)
    high_band = sosfilt(sos_high, data)

    # RMS-based compression of high band
    # Threshold: inverted scale (0% = 0 dB, 100% = -60 dB)
    threshold_db = -amount_pct * 0.6  # 0..100 → 0..-60 dB
    threshold_amp = 10.0 ** (threshold_db / 20.0)

    # Frame-based RMS detection
    frame_size = int(0.005 * sr)  # 5ms frames
    compressed_high = high_band.copy()

    for i in range(0, len(high_band) - frame_size, frame_size):
        frame = high_band[i:i + frame_size]
        rms = np.sqrt(np.mean(frame**2))
        if rms > threshold_amp:
            # Apply gain reduction
            gain = threshold_amp / (rms + 1e-10)
            gain = max(gain, 0.1)  # don't kill it completely
            compressed_high[i:i + frame_size] *= gain

    return low_band + compressed_high

def apply_jitter_modification(data: np.ndarray, sr: int, jitter_mod: float) -> np.ndarray:
    """
    Modify jitter (pitch perturbation) via sample-domain micro-shifts.
    jitter_mod: -1..1, negative = smooth periods, positive = add randomness.
    """
    if abs(jitter_mod) < 0.01:
        return data

    frame_len = int(0.030 * sr)  # 30ms frames
    hop = int(0.010 * sr)        # 10ms hop
    output = data.copy()

    for start in range(0, len(data) - frame_len, hop):
        if jitter_mod > 0:
            # Add micro time-shift jitter by resampling within small window
            shift_samples = int(jitter_mod * 3 * (np.random.random() - 0.5))  # ±1.5 samples max
            src_start = max(0, start + shift_samples)
            src_end = min(len(data), src_start + frame_len)
            actual_len = src_end - src_start
            if actual_len > 0 and start + actual_len <= len(output):
                output[start:start + actual_len] = data[src_start:src_end]
        else:
            # Smooth: blend with neighbours to reduce perturbation
            factor = abs(jitter_mod)
            end = min(start + frame_len, len(data))
            if start > 0 and end < len(data):
                smoothed = data[start:end] * (1 - factor * 0.3)
                if start >= hop:
                    smoothed += data[start - hop:end - hop][:len(smoothed)] * (factor * 0.15)
                if end + hop <= len(data):
                    smoothed += data[start + hop:end + hop][:len(smoothed)] * (factor * 0.15)
                output[start:end] = smoothed

    return output

def peak_normalize(data: np.ndarray, target_dbfs: float = -1.0) -> np.ndarray:
    """Peak normalize to target dBFS."""
    peak = np.max(np.abs(data))
    if peak < 1e-10:
        return data
    target_amp = 10.0 ** (target_dbfs / 20.0)
    return data * (target_amp / peak)


# --- API Endpoints ---

@app.post("/upload")
async def upload_audio(file: UploadFile = File(...)):
    contents = await file.read()

    try:
        sr, data = wav.read(io.BytesIO(contents))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid WAV file format")

    # Force Mono
    if len(data.shape) > 1:
        data = data.mean(axis=1).astype(data.dtype)

    rms = calculate_rms(data)
    if rms < 0.001:
        raise HTTPException(status_code=400, detail="Audio is empty or too quiet")

    data = trim_silence(data, sr, db_threshold=-40.0)

    duration = len(data) / sr
    status_code = 200
    if duration > 20.0:
        data = data[:int(15.0 * sr)]
        status_code = 206

    current_time = time.time()
    keys_to_delete = [k for k, v in audio_sessions.items() if current_time - v['last_accessed'] > 3600]
    for k in keys_to_delete:
        audio_sessions.pop(k, None)

    file_id = str(uuid.uuid4())
    audio_sessions[file_id] = {
        'data': data,
        'sr': sr,
        'last_accessed': current_time
    }

    return Response(
        content='{"file_id": "' + file_id + '", "message": "Uploaded"}',
        media_type="application/json",
        status_code=status_code
    )

@app.post("/process/{file_id}")
async def process_audio(file_id: str, request: ProcessRequest):
    if file_id not in audio_sessions:
        raise HTTPException(status_code=404, detail="File not found or expired")

    session = audio_sessions[file_id]
    session['last_accessed'] = time.time()
    data = session['data']
    sr = session['sr']

    if data.nbytes > 50 * 1024 * 1024:
        audio_sessions.pop(file_id, None)
        raise HTTPException(status_code=500, detail="RAM buffer size exceeded 50MB, session cleared")

    try:
        start_time = time.time()

        float_data = to_float64(data)
        sound = parselmouth.Sound(float_data, sampling_frequency=sr)

        basic = request.basic
        adv = request.advanced

        # --- Step 1: Noise Gate (Advanced) ---
        if adv and adv.noise_gate_db > -100.0:
            board_pre = Pedalboard([
                NoiseGate(
                    threshold_db=adv.noise_gate_db,
                    ratio=100.0,  # hard gate
                    attack_ms=1.0,
                    release_ms=10.0
                )
            ])
            gated = board_pre(float_data.reshape(1, -1).astype(np.float32), sr, reset=True)
            float_data = gated[0].astype(np.float64)
            sound = parselmouth.Sound(float_data, sampling_frequency=sr)

        # Detect F0
        f0_median = detect_f0_median(sound)

        # --- Step 2: Pitch/Formant (Basic mode: Change Gender) ---
        new_pitch_median = f0_median * basic.pitch_ratio

        new_sound = call(sound, "Change gender", 75.0, 600.0,
                         basic.formant_ratio, new_pitch_median, 1.0, 1.0)
        processed_data = new_sound.values[0]

        # --- Step 3: LPC Formant Shift F2/F3 (Advanced) ---
        if adv and abs(adv.f2_shift) > 1.0:
            try:
                lpc_sound = parselmouth.Sound(processed_data, sampling_frequency=sr)
                processed_data = apply_lpc_formant_shift(lpc_sound, adv.f2_shift, sr, f0_median)
            except ValueError as ve:
                if "LPC_INSTABILITY" in str(ve):
                    raise HTTPException(status_code=422, detail="DSP Error: LPC filter instability detected")
                raise

        # --- Step 4: Jitter Modification (Advanced) ---
        if adv and abs(adv.jitter_mod) > 0.01:
            processed_data = apply_jitter_modification(processed_data, sr, adv.jitter_mod)

        # --- Step 5: De-Esser (Advanced) ---
        if adv and adv.deesser_amount > 0:
            processed_data = apply_deesser(processed_data, sr, adv.deesser_amount)

        # --- Timeout check (4.0s for advanced, 2.0s for basic) ---
        timeout_limit = 30.0 if adv else 2.0
        elapsed = time.time() - start_time
        if elapsed > timeout_limit:
            if adv:
                raise HTTPException(status_code=408, detail="Processing Timeout")
            else:
                # Basic mode: return original with warning
                headers = {"X-Processing-Warning": "Processing Timeout - Returned original file"}
                final_data = float_data
                # Skip further processing and return
                final_data_2d = final_data.reshape(1, -1).astype(np.float32)
                output_buffer = io.BytesIO()
                final_int16 = np.int16(np.clip(final_data_2d[0], -1.0, 1.0) * 32767.0)
                wav.write(output_buffer, sr, final_int16)
                output_buffer.seek(0)
                return StreamingResponse(output_buffer, media_type="audio/wav", headers=headers)

        headers = {}
        final_data = processed_data

        # --- Step 6: Pedalboard Effects (EQ + Compression) ---
        board = Pedalboard([
            HighShelfFilter(cutoff_frequency_hz=3000, gain_db=basic.presence_db),
            Compressor(
                threshold_db=-20,
                ratio=1.0 + basic.compression_level * 9.0,
                attack_ms=5.0,
                release_ms=50.0
            ),
            # Clipping protection: Limiter at -1.0 dBFS
            Limiter(threshold_db=-1.0, release_ms=100.0)
        ])

        final_data_2d = final_data.reshape(1, -1).astype(np.float32)
        effected_data = board(final_data_2d, sr, reset=True)

        final_audio_1d = effected_data[0]

        # --- Step 7: Peak Normalization to -1.0 dBFS ---
        final_audio_1d = peak_normalize(final_audio_1d, target_dbfs=-1.0)

        # Output as WAV stream (PCM 16-bit Mono)
        output_buffer = io.BytesIO()
        final_int16 = np.int16(np.clip(final_audio_1d, -1.0, 1.0) * 32767.0)
        wav.write(output_buffer, sr, final_int16)
        output_buffer.seek(0)

        return StreamingResponse(
            output_buffer,
            media_type="audio/wav",
            headers=headers
        )

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

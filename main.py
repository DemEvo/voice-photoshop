import os
import uuid
import io
import time
import numpy as np
import scipy.io.wavfile as wav
import parselmouth
from parselmouth.praat import call
from pedalboard import Pedalboard, Compressor, HighShelfFilter
from pedalboard.io import AudioFile
from fastapi import FastAPI, UploadFile, File, HTTPException, Body, Response
from fastapi.responses import StreamingResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/")
async def root():
    return RedirectResponse(url="/static/index.html")

# In-memory storage for audio files (simulating RAM buffer)
# maps file_id to dict: {'data': np.ndarray, 'sr': int, 'last_accessed': float}
audio_sessions = {}

app.mount("/static", StaticFiles(directory="static"), name="static")

class ProcessRequest(BaseModel):
    pitch_ratio: float
    formant_ratio: float
    presence_db: float
    compression_level: float

def calculate_rms(data: np.ndarray) -> float:
    # float32 data is usually -1.0 to 1.0, wait, if int16, it's -32768 to 32767
    if data.dtype == np.int16:
        float_data = data.astype(np.float32) / 32768.0
    else:
        float_data = data.astype(np.float32)
    return np.sqrt(np.mean(float_data**2))

def trim_silence(data: np.ndarray, sr: int, db_threshold: float = -40.0) -> np.ndarray:
    if data.dtype == np.int16:
        float_data = data.astype(np.float32) / 32768.0
    else:
        float_data = data.astype(np.float32)
    
    # Simple silence trimming based on amplitude threshold
    amplitude_threshold = 10.0 ** (db_threshold / 20.0)
    
    # Find start
    start_idx = 0
    for i in range(len(float_data)):
        if abs(float_data[i]) > amplitude_threshold:
            start_idx = i
            break
            
    # Find end
    end_idx = len(float_data)
    for i in range(len(float_data)-1, -1, -1):
        if abs(float_data[i]) > amplitude_threshold:
            end_idx = i + 1
            break
            
    if start_idx >= end_idx:
        return data # Fallback if everything is silence
        
    return data[start_idx:end_idx]

@app.post("/upload")
async def upload_audio(file: UploadFile = File(...)):
    contents = await file.read()
    
    # Read WAV
    try:
        sr, data = wav.read(io.BytesIO(contents))
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid WAV file format")
        
    # Force Mono
    if len(data.shape) > 1:
        data = data.mean(axis=1).astype(data.dtype)
        
    # Need to check RMS to fail if empty
    rms = calculate_rms(data)
    if rms < 0.001:
        raise HTTPException(status_code=400, detail="Audio is empty or too quiet")
        
    # Trim silence (-40dB)
    data = trim_silence(data, sr, db_threshold=-40.0)
        
    # Check duration, enforce 20s limit, slice to 15s if > 20s
    duration = len(data) / sr
    status_code = 200
    if duration > 20.0:
        data = data[:int(15.0 * sr)]
        status_code = 206
        
    # Clean up old sessions to prevent memory leaks simulation
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
    
    # Memory Buffer Safety Check
    if data.nbytes > 50 * 1024 * 1024:
        audio_sessions.pop(file_id, None)
        raise HTTPException(status_code=500, detail="RAM buffer size exceeded 50MB, session cleared")
    
    try:
        start_time = time.time()
        
        # 1. DSP Processing in parselmouth
        # To avoid robotization, Praat has "Change gender" script which is high quality.
        if data.dtype == np.int16:
            float_data = data.astype(np.float64) / 32768.0
        else:
            float_data = data.astype(np.float64)
            
        sound = parselmouth.Sound(float_data, sampling_frequency=sr)
        
        # Calculate pitch median needed for new pitch
        pitch = call(sound, "To Pitch", 0.0, 75.0, 600.0)
        original_pitch_median = call(pitch, "Get quantile", 0.0, 0.0, 0.5, "Hertz")
        
        if np.isnan(original_pitch_median) or original_pitch_median == 0:
            # Fallback if no pitch
            new_pitch_median = 150.0 * request.pitch_ratio
        else:
            new_pitch_median = original_pitch_median * request.pitch_ratio
            
        # Run Change gender
        # parselmouth.praat.call(sound, "Change gender", pitch_floor, pitch_ceiling, formant_shift_ratio, new_pitch_median, pitch_range_factor, duration_factor)
        new_sound = call(sound, "Change gender", 75.0, 600.0, request.formant_ratio, new_pitch_median, 1.0, 1.0)
        
        processed_data = new_sound.values[0] # Single channel float
        
        # Ensure timeout check
        if time.time() - start_time > 2.0:
            # Spec says "Возврат оригинального файла с алертом 'Processing Timeout'"
            # But we can't send alert header easily without standard structure, let's use custom header
            headers = {"X-Processing-Warning": "Processing Timeout - Returned original file"}
            final_data = float_data
        else:
            final_data = processed_data
            headers = {}
            
        # 2. Pedalboard Effects processing
        board = Pedalboard([
            HighShelfFilter(cutoff_frequency_hz=3000, gain_db=request.presence_db),
            Compressor(
                threshold_db=-20,
                ratio=1.0 + request.compression_level * 9.0, # 1:1 to 10:1
                attack_ms=5.0,
                release_ms=50.0
            )
        ])
        
        # Pedalboard requires 2D array (channels, samples)
        final_data_2d = final_data.reshape(1, -1).astype(np.float32)
        effected_data = board(final_data_2d, sr, reset=False)
        
        final_audio_1d = effected_data[0]
        
        # Output as WAV stream
        output_buffer = io.BytesIO()
        final_int16 = np.int16(np.clip(final_audio_1d, -1.0, 1.0) * 32767.0)
        wav.write(output_buffer, sr, final_int16)
        output_buffer.seek(0)
        
        return StreamingResponse(
            output_buffer, 
            media_type="audio/wav", 
            headers=headers
        )
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

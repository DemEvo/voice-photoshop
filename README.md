# Voice Photoshop MVP

Local Voice Reference Editor matching the technical specification `create_tspec.md`, utilizing Python, FastAPI, Vanilla JS, and `praat-parselmouth` for high-quality DSP audio processing.

## Features
* **Zero AI / Local Only**: No external APIs or neural networks are used, strictly standard DSP logic.
* **Core DSP Engine**: Uses `praat-parselmouth` for accurate and natural pitch/formant modifications.
* **Audio FX Layer**: `pedalboard` provides zero-latency EQ (High-Shelf) and dynamic range compression.
* **Memory Buffered**: Files are processed entirely in memory buffers, optimizing privacy and latency.
* **Web UI Component**: Minimalist dark-mode web application implementing the interactions.

## How to run
1. Activate the environment:
```bash
source venv/bin/activate
```
2. Start the local server:
```bash
uvicorn main:app --host 127.0.0.1 --port 8000
```
3. Open your browser to http://127.0.0.1:8000/static/index.html

## Specifications matched
- Pitch ratio mutation (`pitch_ratio`)
- Formant ratio mutation (`formant_ratio`)
- Voice EQ filter (`presence_db`)
- Compressor mix (`compression_level`)
- Hard constraints (audio duration max 20s, file cleanup) and proper error handling.

```bash
 pip install -r requirements.txt
```

```bash
 uvicorn main:app --host 127.0.0.1 --port 8000
```



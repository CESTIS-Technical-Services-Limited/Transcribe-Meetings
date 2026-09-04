# VoiceScript Studio 🎙️

**Private, production-ready AI transcription that runs entirely in your browser —
built for the ambitious jobs: day-long recordings, multi-speaker meetings, live
calls, and 99 languages.**

Upload audio/video files, capture an online meeting straight from a browser tab,
or record live with your microphone, and get accurate, timestamped, speaker-labelled
transcripts powered by OpenAI's Whisper and pyannote speaker models running **on
your own device** — no server, no account, no upload. Your recordings never leave
your computer.

## Features

- **Any length** — WAV and MP3 files are read straight from disk in chunks, so
  day-long recordings and multi-gigabyte files never have to fit in memory.
  Other formats (MP4, M4A, OGG/Opus, WebM, FLAC, AAC, MOV) are decoded once by
  the browser and kept as compact 16-bit audio.
- **Who said what** — on-device speaker identification (pyannote segmentation +
  WeSpeaker voice embeddings, clustered locally). Speakers are colour-coded,
  renamable with one click, and included in every export. Tell the app how many
  speakers to expect for the most accurate result, or let it detect the number.
- **Capture online meetings** — record a Chrome tab or your system audio (with or
  without your microphone) for Zoom, Meet, Teams and webinars.
- **Live captions while you record** — see a running preview of what is being
  said; the full-accuracy pass runs when you stop.
- **Resumable** — stop or lose a job hours in and pick it up where it left off.
  Progress is checkpointed after every window, interrupted sessions are detected
  on reload, and the screen is kept awake while a job runs.
- **Accurate AI engine** — Whisper (Tiny → Large-v3) via
  [transformers.js](https://github.com/huggingface/transformers.js), with:
  - WebGPU acceleration (automatic, with CPU/WASM fallback)
  - two Web Workers: Whisper and speaker analysis run in parallel, the UI never freezes
  - audio conditioning: band-limited 16 kHz resampling, 80 Hz high-pass, level normalisation
  - silence-aware windowing so long recordings are cut between words
  - repetition suppression plus hallucination/boilerplate filtering
  - any ONNX Whisper model from the Hugging Face Hub (English-only, distilled or
    domain fine-tuned variants) via Settings → Advanced, and a configurable model
    mirror for locked-down networks
- **99 languages** with auto-detection, plus "translate to English" mode.
- **Transcript workspace** — timestamped segments, click a timestamp to jump the
  audio player, follow-along highlighting, playback speed, keyboard shortcuts
  (Ctrl+Enter play/pause, Ctrl+Shift+←/→ seek, Ctrl+Shift+↑ play from the line
  you are editing), in-place editing (autosaved), and full-text search.
- **Library** — every transcript (and its source audio) is stored locally in
  your browser (IndexedDB) and searchable from the sidebar. Export the whole
  library as one ZIP.
- **Exports** — TXT, Word (**real .docx**, dependency-free), PDF, SRT subtitles,
  WebVTT (with voice tags), CSV, JSON, and the original audio. Optional
  timestamps; speaker names everywhere.
- **AI assistant (optional)** — clean-up, summary, meeting minutes, action
  items, questions asked, speaker naming, translation or a custom prompt,
  powered by Claude Opus 5 with streamed output. Transcripts too long for one
  request are processed part by part and merged. Bring your own
  [Anthropic API key](https://console.anthropic.com/); it is stored only in your
  browser and used only when you run an action.
- **Resilient** — cancellable jobs, retry/resume from stored audio, live ETA,
  CDN fallbacks, friendly error messages, mobile layout.

## Getting started

The whole app is a single `index.html` — there is no build step.

### Option 1: GitHub Pages (recommended)

1. In this repository go to **Settings → Pages**.
2. Under *Build and deployment*, choose **Deploy from a branch**, select the
   `main` branch and the `/ (root)` folder, then save.
3. Open `https://<your-username>.github.io/Transcribe-Meetings/`.

### Option 2: Any static host / local server

```bash
# from the repository folder
python3 -m http.server 8080
# then open http://localhost:8080
```

Netlify, Vercel, Cloudflare Pages, S3 — anything that serves static files works.

### Option 3: Open the file directly

Double-clicking `index.html` works in Chrome/Edge for most features. Serving it
over HTTP(S) is more reliable (microphone, tab capture and workers behave best
in a secure context).

## Taking on big jobs

| Job | How |
|---|---|
| A 10-hour recording | Save it as WAV or MP3 (any recorder or `ffmpeg -i in.m4a out.mp3`). Both are streamed from disk window by window, so length is limited only by patience, not memory. |
| A 3-hour Zoom/Teams `.m4a` or `.mp4` | Works as-is: the browser decodes it once (roughly 250 MB of RAM per hour of audio while decoding). Beyond ~4–5 hours convert to MP3 first. |
| A meeting with six people | Set **Speakers → Up to 6** (or leave on auto), then click any speaker label to rename it; names flow into every export and into the AI assistant. |
| An online call happening right now | Record → Source → *Microphone + tab/system audio*, pick the meeting tab and tick *Share audio*. Live captions show what is being said as it happens. |
| Maximum accuracy | Choose *Maximum (Large-v3 Turbo)*, or *Ultimate (Large-v3)* on a machine with a strong GPU. On CPU-only machines *Balanced* is the sweet spot. |
| A specialised domain or dialect | Settings → Advanced → paste any Hugging Face repo that ships ONNX Whisper weights (e.g. an English-only or fine-tuned model) and pick *Custom model* as the accuracy. |
| Offline use | Settings → Advanced → *Download models now* while online; everything is cached by the browser afterwards. |
| A network that blocks huggingface.co | Settings → Advanced → point *Model host* at a mirror or your own server exposing the same paths. |

## How the engine works

1. The file is opened as a **streaming audio source**. WAV (including RF64 and
   8/16/24/32-bit, float) is parsed directly; MP3 is indexed frame by frame once,
   then decoded by byte range with the encoder/decoder delay compensated for
   accurate timestamps. Other formats are decoded by the browser once.
2. Audio is processed in ~2 minute windows, each cut at the quietest moment in the
   last 55 seconds so words are never chopped, then resampled to 16 kHz mono with
   a band-limited windowed-sinc filter, high-passed at 80 Hz and level-normalised.
   Silent windows are skipped.
3. Each window goes to two workers in parallel: **Whisper** (30 s chunks with 5 s
   overlap, timestamps, 5-gram repetition suppression) on the GPU when WebGPU is
   available, and **pyannote segmentation** (10 s chunks) on the CPU, which finds
   who is speaking when; a **WeSpeaker** embedding is computed for every local
   speaker.
4. After the last window, embeddings are clustered (weighted average-linkage,
   cosine distance) into global speakers — optionally capped at the number you
   chose — and each transcript line is labelled with the speaker who talked most
   during it.
5. Output is filtered for Whisper's classic failure modes (repetition loops,
   "thanks for watching" boilerplate) and streamed into the transcript view live;
   progress, speed and ETA are shown and checkpointed for resume.

Model files download once from the Hugging Face Hub (~50 MB Tiny to ~1.6 GB
Large-v3, plus ~35 MB for the speaker models) and are cached by the browser.

## Browser support

| Browser | Transcription | GPU acceleration | Tab/system audio capture |
|---|---|---|---|
| Chrome / Edge 121+ | ✅ | ✅ WebGPU | ✅ |
| Firefox 141+ | ✅ | ✅ WebGPU (Windows; other platforms use CPU) | ❌ (microphone only) |
| Safari 17+ | ✅ | CPU (WASM) | ❌ (microphone only) |

Speaker identification always runs on the CPU and adds roughly 10–20 % to the
processing time. The "Ultimate" model needs WebGPU and several GB of free RAM.

## Privacy

- Audio, transcripts and settings are stored in your browser only (IndexedDB).
- Transcription and speaker identification are fully local. The only network
  traffic is downloading the engine/model files from CDNs (jsDelivr/unpkg +
  huggingface.co, or your configured mirror) on first use.
- The optional AI assistant sends transcript text directly from your browser
  to `api.anthropic.com`, only when you explicitly run it, using your own key.
- "Delete all data" in Settings wipes everything.

## Development

Everything lives in `index.html`: styles, markup, the app code, and the Web
Worker source for the engines (in a `<script type="text/plain" id="engine-src">`
block). Edit and refresh — no toolchain required.

The app exposes its internals on `window.__vs` for automated tests and console
debugging (audio sources, resampler, speaker assignment, exporters). The engine
workers can be swapped for mocks by replacing methods on `__vs.engine` and
`__vs.speakerEngine`, which is how the headless browser suite exercises the whole
pipeline (chunked decoders with sample-accurate timing checks, windowing, cancel
and resume, speaker labelling, exports, live captions, and the AI assistant's
streaming and chunking) without downloading model weights.

### Running the tests

```bash
pip install numpy av lameenc          # encoders for the generated test media
python3 tests/gen_media.py            # writes tone-burst WAV/MP3/M4A/OGG/WebM/FLAC files to tests/media
npm install -g playwright http-server # Chromium via `npx playwright install chromium`
http-server . -p 8080 -c-1 &          # serve the repository root
node tests/e2e.js                     # optional filter: node tests/e2e.js decoders
```

/* Headless-Chromium test suite for VoiceScript Studio.
   Run: node e2e.js [filter]
   Model weights cannot be downloaded in this sandbox, so the Whisper /
   speaker workers are mocked in the page; everything else (decoders,
   windowing, resume, speakers, UI, exports, AI streaming) is real. */
const { chromium } = (() => { try { return require('playwright'); } catch (e) { return require('/opt/node22/lib/node_modules/playwright'); } })();
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const URL = 'http://127.0.0.1:8080/index.html';
const MEDIA = path.join(__dirname, 'media');
const BT = [1, 5, 9, 13, 17, 21, 25];
const filter = process.argv[2] || '';
let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push('  ✔ ' + name); }
  else { failed++; results.push('  ✘ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
function close(a, b, tol) { return Math.abs(a - b) <= tol; }

// Injected into the page: burst detector + engine mocks.
const PAGE_HELPERS = `
window.__detectBursts = function (x, sr) {
  sr = sr || 16000; const frame = sr / 100; const times = []; let inB = false;
  for (let i = 0; i + frame <= x.length; i += frame) {
    let e = 0; for (let j = i; j < i + frame; j++) e += x[j] * x[j];
    const rms = Math.sqrt(e / frame);
    if (!inB && rms > 0.08) { inB = true; times.push(i / sr); } else if (inB && rms < 0.02) inB = false;
  }
  return times;
};
window.__mockEngines = function (opts) {
  opts = opts || {};
  const e = __vs.engine, d = __vs.speakerEngine;
  window.__calls = { transcribe: [], diarize: [], speakers: [] };
  e.ensureLoaded = async (m, cb) => { if (cb) cb({ file: 'x', loaded: 50, total: 100 }); e.loadedKey = 'whisper|' + m + '|'; e.device = 'wasm'; return 'wasm'; };
  e.transcribe = async (audio, offset) => {
    __calls.transcribe.push(offset);
    if (opts.delay) await new Promise(r => setTimeout(r, opts.delay));
    if (opts.fail && offset >= opts.fail) throw new Error('mock engine failure');
    return __detectBursts(audio).map(b => ({ start: offset + b, end: offset + b + 0.5, text: 'Burst at ' + Math.round(offset + b) + ' seconds' }));
  };
  e.reset = () => {};
  d.ensureSpeakersLoaded = async () => { if (opts.noSpeakers) throw new Error('no speaker models'); };
  d.resetSpeakers = async () => {};
  d.diarize = async (audio, offset) => { __calls.diarize.push(offset); };
  d.speakers = async (max) => { __calls.speakers.push(max); return { turns: opts.turns || [{ start: 0, end: 12, spk: 0 }, { start: 12, end: 99999, spk: 1 }], count: 2 }; };
  d.reset = () => {};
};
`;

async function waitStatus(page, status, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 60000)) {
    const s = await page.evaluate(() => __vs.state.transcripts[0] && __vs.state.transcripts[0].status);
    if (s === status) return true;
    await page.waitForTimeout(150);
  }
  return false;
}
async function freshPage(browser, opts) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|mock engine failure/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__vs && document.querySelector('#dropzone'));
  await page.evaluate(PAGE_HELPERS);
  return { ctx, page, errors };
}
async function waitJob(page, timeout) {   // wait for a job to start, then finish
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (await page.evaluate(() => !!__vs.state.job)) break;
    await page.waitForTimeout(50);
  }
  while (Date.now() - t0 < (timeout || 60000)) {
    if (!(await page.evaluate(() => !!__vs.state.job))) return await page.evaluate(() => __vs.state.transcripts[0].status);
    await page.waitForTimeout(150);
  }
  return 'timeout';
}

const suites = {};

/* 1. Audio sources against generated media */
suites.decoders = async (browser) => {
  const { ctx, page, errors } = await freshPage(browser);
  const files = [
    ['burst_44k_s16_stereo.wav', 'wav'], ['burst_16k_s16_mono.wav', 'wav'], ['burst_48k_s24_stereo.wav', 'wav'],
    ['burst_48k_f32_stereo.wav', 'wav'], ['burst_11k_u8_mono.wav', 'wav'],
    ['burst_44k_cbr128.mp3', 'mp3'], ['burst_16k_mono.mp3', 'mp3'], ['burst_44k_id3.mp3', 'mp3'],
    ['burst_48k.ogg', 'full'], ['burst_48k.webm', 'full'], ['burst_44k.flac', 'full'], ['burst_44k.m4a', 'full'],
  ];
  for (const [name, kind] of files) {
    if (!fs.existsSync(path.join(MEDIA, name))) { check(name + ' exists', false, 'missing'); continue; }
    const buf = fs.readFileSync(path.join(MEDIA, name));
    const r = await page.evaluate(async ({ name, b64 }) => {
      const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const file = new File([u8], name, { type: '' });
      const t0 = performance.now();
      try {
        const src = await __vs.openAudioSource(file);
        const full = await src.read(0, src.durationSec);
        const sub = await src.read(8.5, 14.2);
        const edge = await src.read(4.9, 5.3);
        return { kind: src.kind, dur: src.durationSec, fullLen: full.length, bursts: __detectBursts(full), sub: __detectBursts(sub), subLen: sub.length, edgeLen: edge.length, edgeBursts: __detectBursts(edge), ms: performance.now() - t0 };
      } catch (e) { return { error: e.message }; }
    }, { name, b64: buf.toString('base64') });
    if (r.error) {
      // Chromium (open-source) has no AAC decoder; anything else failing is a bug.
      check(name + ' decodes', name.endsWith('.m4a') && /decoded as audio/.test(r.error), r.error);
      continue;
    }
    check(name + ' uses ' + kind + ' reader', r.kind === kind, r.kind);
    check(name + ' duration ≈ 28 s', close(r.dur, 28, 0.15), r.dur);
    check(name + ' output length matches duration', close(r.fullLen, r.dur * 16000, 200), r.fullLen);
    const tol = kind === 'mp3' ? 0.06 : 0.03;
    const ok = r.bursts.length === BT.length && r.bursts.every((b, i) => close(b, BT[i], tol));
    check(name + ' burst timing (±' + tol * 1000 + ' ms)', ok, JSON.stringify(r.bursts));
    check(name + ' window 8.5–14.2 s', r.sub.length === 2 && close(r.sub[0], 0.5, tol) && close(r.sub[1], 4.5, tol) && close(r.subLen, 5.7 * 16000, 2), JSON.stringify([r.sub, r.subLen]));
    check(name + ' window 4.9–5.3 s', r.edgeLen === Math.round(0.4 * 16000) && r.edgeBursts.length === 1 && close(r.edgeBursts[0], 0.1, tol), JSON.stringify([r.edgeLen, r.edgeBursts]));
  }
  // long files: read a window deep inside without decoding everything
  for (const name of ['long_40min.mp3', 'long_40min_16k.wav']) {
    const p = path.join(MEDIA, name);
    if (!fs.existsSync(p)) { check(name + ' exists', false, 'missing'); continue; }
    const r = await page.evaluate(async ({ url, name }) => {
      const resp = await fetch(url); const blob = await resp.blob();
      const file = new File([blob], name);
      const t0 = performance.now();
      const src = await __vs.openAudioSource(file, () => {});
      const opened = performance.now() - t0;
      const w = await src.read(1500, 1675);
      const tail = await src.read(src.durationSec - 100, src.durationSec);
      return { kind: src.kind, dur: src.durationSec, opened, bursts: __detectBursts(w), tail: __detectBursts(tail), tailLen: tail.length };
    }, { url: 'http://127.0.0.1:8080/__media/' + name, name });
    check(name + ' streams (' + r.kind + ') and indexes quickly', r.kind !== 'full' && r.opened < 8000, JSON.stringify([r.kind, Math.round(r.opened) + ' ms']));
    check(name + ' duration ≈ 40 min', close(r.dur, 2400, 0.2), r.dur);
    check(name + ' mid-file window bursts at 1530/1590/1650 s', r.bursts.length === 3 && close(r.bursts[0], 30, 0.05) && close(r.bursts[1], 90, 0.05) && close(r.bursts[2], 150, 0.05), JSON.stringify(r.bursts));
    check(name + ' tail window bursts', r.tail.length === 2 && close(r.tail[0], 10, 0.07) && close(r.tail[1], 70, 0.07) && close(r.tailLen, 100 * 16000, 2), JSON.stringify([r.tail, r.tailLen]));
  }
  // pure functions
  const pf = await page.evaluate(() => {
    const out = {};
    // resampler: a 440 Hz tone at 44.1k stays 440 Hz at 16k, unit gain
    const sr = 44100, n = sr; const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 440 * i / sr);
    const y = __vs.resampleTo16k(x, sr);
    let zc = 0; for (let i = 1 + 800; i < y.length - 800; i++) if ((y[i - 1] < 0) !== (y[i] < 0)) zc++;
    let peak = 0; for (let i = 800; i < y.length - 800; i++) peak = Math.max(peak, Math.abs(y[i]));
    out.rsLen = y.length; out.rsHz = zc / 2 / ((y.length - 1600) / 16000); out.rsPeak = peak;
    // aliasing: 12 kHz tone must be attenuated after downsampling (above 8 kHz Nyquist)
    const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = Math.sin(2 * Math.PI * 12000 * i / sr);
    const ya = __vs.resampleTo16k(a, sr); let ap = 0; for (let i = 800; i < ya.length - 800; i++) ap = Math.max(ap, Math.abs(ya[i]));
    out.aliasPeak = ap;
    // upsampling 8k -> 16k
    const u = new Float32Array(8000); for (let i = 0; i < 8000; i++) u[i] = Math.sin(2 * Math.PI * 300 * i / 8000);
    out.upLen = __vs.resampleTo16k(u, 8000).length;
    // quietestCut picks the silent gap
    const q = new Float32Array(16000 * 4); for (let i = 0; i < q.length; i++) q[i] = (i > 16000 * 1.5 && i < 16000 * 2.5) ? 0 : 0.3 * Math.sin(i);
    out.cut = __vs.quietestCut(q, 16000, q.length) / 16000;
    // conditionWindow normalises quiet audio but not silence
    const quiet = new Float32Array(16000); for (let i = 0; i < quiet.length; i++) quiet[i] = 0.05 * Math.sin(2 * Math.PI * 300 * i / 16000);
    __vs.conditionWindow(quiet); let qp = 0; for (let i = 2000; i < quiet.length; i++) qp = Math.max(qp, Math.abs(quiet[i]));
    out.normPeak = qp;
    // assignSpeakers majority overlap + nearest fallback
    const segs = [{ start: 0, end: 4, text: 'a b c d' }, { start: 4.5, end: 9, text: 'e f' }, { start: 20, end: 21, text: 'g' }, { start: 22, end: 23, text: 'h i j k' }, { start: 30, end: 31, text: 'far' }];
    __vs.assignSpeakers(segs, [{ start: 0, end: 5, spk: 0 }, { start: 5, end: 10, spk: 1 }, { start: 19, end: 20.9, spk: 1 }, { start: 22, end: 23, spk: 0 }]);
    out.spk = segs.map(s => s.spk);
    out.split = __vs.splitTranscriptText('a\nbb\nccc\ndddd', 6).length;
    return out;
  });
  check('resampler 44.1k→16k length', close(pf.rsLen, 16000, 2), pf.rsLen);
  check('resampler keeps 440 Hz', close(pf.rsHz, 440, 3), pf.rsHz);
  check('resampler unit gain', close(pf.rsPeak, 1, 0.03), pf.rsPeak);
  check('resampler rejects >Nyquist (aliasing)', pf.aliasPeak < 0.05, pf.aliasPeak);
  check('resampler upsamples 8k→16k', pf.upLen === 16000, pf.upLen);
  check('quietestCut finds the gap', pf.cut > 1.5 && pf.cut < 2.5, pf.cut);
  check('conditionWindow normalises level', pf.normPeak > 0.5 && pf.normPeak <= 0.95, pf.normPeak);
  check('assignSpeakers', JSON.stringify(pf.spk) === JSON.stringify([0, 1, 1, 0, null]), JSON.stringify(pf.spk));
  check('splitTranscriptText keeps lines whole', pf.split === 3, pf.split);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
};

/* 2. Full pipeline with mocked engines: upload, speakers, UI, exports */
suites.pipeline = async (browser) => {
  const { ctx, page, errors } = await freshPage(browser);
  await page.evaluate(() => __mockEngines({}));
  await page.setInputFiles('#file-input', path.join(MEDIA, 'burst_44k_cbr128.mp3'));
  check('job shows progress panel', await page.waitForSelector('#proc-panel', { timeout: 10000 }).then(() => true).catch(() => false));
  check('transcript finishes', await waitStatus(page, 'ready', 60000));
  const t = await page.evaluate(() => JSON.parse(JSON.stringify(__vs.state.transcripts[0])));
  check('7 segments from bursts', t.segments.length === 7, t.segments.length);
  check('segment times correct', t.segments.every((s, i) => close(s.start, BT[i], 0.1)), JSON.stringify(t.segments.map(s => s.start)));
  check('duration recorded', close(t.durationSec, 28, 0.15), t.durationSec);
  check('processedSec reaches end', close(t.processedSec, t.durationSec, 0.01), t.processedSec);
  check('speakers assigned by overlap', t.segments.map(s => s.spk).join('') === '0001111', t.segments.map(s => s.spk).join(''));
  check('speakerCount stored', t.speakerCount === 2 && t.diarized === true);
  check('diarize called per window', (await page.evaluate(() => __calls.diarize.length)) === 1);
  check('UI shows speaker labels', (await page.$$eval('.seg-spk', els => els.map(e => e.textContent))).join(',') === 'Speaker 1,Speaker 2');
  check('7 segment rows rendered', (await page.$$('.seg')).length === 7);
  // rename a speaker
  await page.click('.seg-spk');
  await page.fill('#pd-in', 'Alice');
  await page.click('#pd-yes');
  await page.waitForTimeout(200);
  check('speaker renamed everywhere', (await page.$$eval('.seg-spk', els => els.map(e => e.textContent))).join(',') === 'Alice,Speaker 2');
  // exports
  const ex = await page.evaluate(() => {
    const t = __vs.state.transcripts[0];
    return { txt: __vs.transcriptFullText(t, true), srt: __vs.toSrt(t), vtt: __vs.toVtt(t), csv: __vs.toCsv(t), json: JSON.parse(__vs.toJsonExport(t)) };
  });
  check('TXT has timestamps and speakers', /^\[00:01\] Alice: Burst at 1 seconds$/m.test(ex.txt), ex.txt.split('\n')[0]);
  check('SRT numbered with speakers', /^1\n00:00:01,0\d\d --> 00:00:01,5\d\d\nAlice: Burst at 1 seconds/.test(ex.srt), ex.srt.slice(0, 60));
  check('VTT uses voice tags', ex.vtt.startsWith('WEBVTT') && ex.vtt.includes('<v Alice>Burst at 1 seconds</v>'));
  check('CSV has speaker column', ex.csv.split('\n')[0] === 'start,end,speaker,text' && ex.csv.includes('"Alice","Burst at 1 seconds"'));
  check('JSON has speakers map', ex.json.speakers['0'] === 'Alice' && ex.json.segments[6].speaker === 'Speaker 2');
  // DOCX download is a valid zip with the speaker name in it
  await page.click('.tv-actions .btn-primary');
  check('export menu opens', await page.$eval('.menu', el => el.classList.contains('open')));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.menu-item:has-text(".docx")')]);
  const dlPath = path.join(__dirname, 'out.docx');
  await dl.saveAs(dlPath);
  let docxOk = false;
  try { docxOk = execSync(`python3 -c "import zipfile,sys; z=zipfile.ZipFile('${dlPath}'); assert z.testzip() is None; d=z.read('word/document.xml').decode(); assert 'Alice' in d and 'Burst at 25 seconds' in d; print('ok')"`).toString().trim() === 'ok'; } catch (e) { docxOk = false; }
  check('DOCX is a valid zip with speakers', docxOk);
  // bulk export zip
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => App.exportAll())]);
  const zipPath = path.join(__dirname, 'out.zip');
  await dl2.saveAs(zipPath);
  let zipOk = false;
  try { zipOk = execSync(`python3 -c "import zipfile; z=zipfile.ZipFile('${zipPath}'); n=z.namelist(); assert len(n)==3 and any(x.endswith('.srt') for x in n); print('ok')"`).toString().trim() === 'ok'; } catch (e) {}
  check('Export-all ZIP valid', zipOk);
  // search + player + speed
  await page.fill('#tv-search', 'at 9');
  await page.waitForTimeout(400);
  check('search highlights', (await page.textContent('#tv-count')) === '1 match');
  check('player attached', await page.$eval('#player-bar', el => el.style.display !== 'none'));
  await page.selectOption('.player-extra select', '1.5');
  check('playback speed persisted', (await page.evaluate(() => __vs.state.settings.playbackRate)) === 1.5);
  // sidebar meta
  check('sidebar shows speakers', (await page.textContent('.lib-sub')).includes('2 spk'));
  // keyboard shortcuts drive the player
  await page.click('.seg-x[data-i="3"]');
  await page.keyboard.press('Control+Shift+ArrowUp');
  await page.waitForTimeout(300);
  check('Ctrl+Shift+Up seeks to the edited line', close(await page.evaluate(() => document.querySelector('#player').currentTime), 12.9, 1.2), await page.evaluate(() => document.querySelector('#player').currentTime));
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(100);
  check('Ctrl+Enter pauses', await page.evaluate(() => document.querySelector('#player').paused));
  await page.keyboard.press('Control+Shift+ArrowRight');
  check('Ctrl+Shift+Right seeks +5 s', close(await page.evaluate(() => document.querySelector('#player').currentTime), 17.9, 1.5));
  await page.keyboard.press('Escape');
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
};

/* 3. Long file: windowing, cancel, resume, interrupted-session recovery */
suites.resume = async (browser) => {
  const { ctx, page, errors } = await freshPage(browser);
  await page.evaluate(() => __mockEngines({ delay: 250 }));
  await page.setInputFiles('#file-input', path.join(MEDIA, 'long_40min_16k.wav'));
  // stop after a few windows
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const p = await page.evaluate(() => (__vs.state.transcripts[0] || {}).processedSec || 0);
    if (p > 400) break;
    await page.waitForTimeout(100);
  }
  await page.click('text=Stop transcription');
  check('stopped with partial transcript', await waitStatus(page, 'ready', 15000));
  const part = await page.evaluate(() => { const t = __vs.state.transcripts[0]; return { n: t.segments.length, p: t.processedSec, calls: __calls.transcribe.length, dur: t.durationSec }; });
  check('windows are ~2 min and cut at quiet points', part.calls >= 3 && part.p > 300 && part.p < 700, JSON.stringify(part));
  check('resume box shown', await page.$('.resume-box') !== null);
  const expectedPartial = Math.floor((part.p - 30) / 60) + 1;
  check('partial segments match processed range', part.n === expectedPartial, part.n + ' vs ' + expectedPartial);
  // resume
  await page.evaluate(() => { __calls.transcribe = []; __calls.diarize = []; });
  await page.evaluate(() => __mockEngines({ delay: 0 }));
  await page.click('.resume-box .btn-primary');
  check('resume finishes', (await waitJob(page, 120000)) === 'ready');
  const done = await page.evaluate(() => {
    const t = __vs.state.transcripts[0];
    const starts = t.segments.map(s => Math.round(s.start));
    return { n: t.segments.length, p: t.processedSec, dur: t.durationSec, sorted: starts.every((v, i) => i === 0 || v > starts[i - 1]), first: starts[0], last: starts[starts.length - 1], firstT: __calls.transcribe[0], firstD: __calls.diarize[0], spk: t.speakerCount };
  });
  check('all 40 bursts after resume, no duplicates', done.n === 40 && done.sorted && done.first === 30 && done.last === 2370, JSON.stringify(done));
  check('resume skipped already-transcribed audio', done.firstT >= part.p - 1, done.firstT + ' vs ' + part.p);
  check('speakers re-analysed from the start on resume', done.firstD === 0, done.firstD);
  check('processedSec at end', close(done.p, done.dur, 0.01));
  // interrupted-session recovery: mark processing in DB, reload
  await page.evaluate(async () => { const t = __vs.state.transcripts[0]; t.status = 'processing'; t.processedSec = 1000; await __vs.saveTranscript(t); });
  await page.reload();
  await page.waitForFunction(() => window.__vs && __vs.state.transcripts.length);
  await page.evaluate(PAGE_HELPERS);
  const rec = await page.evaluate(() => { const t = __vs.state.transcripts[0]; return { s: t.status, e: t.error }; });
  check('interrupted job recovered as resumable', rec.s === 'error' && /Resume below/.test(rec.e), JSON.stringify(rec));
  await page.evaluate(() => App.go('t/' + __vs.state.transcripts[0].id));
  await page.waitForSelector('.err-box');
  check('resume button offered', (await page.textContent('.err-box')).includes('Resume from 16:40'));
  // failure path: engine error → friendly error, retry possible
  await page.evaluate(() => __mockEngines({ fail: 100 }));
  await page.click('.err-box .btn:not(.btn-primary)');   // start over
  check('failure surfaces as error status', (await waitJob(page, 60000)) === 'error');
  const errT = await page.evaluate(() => __vs.state.transcripts[0].error);
  check('error message kept', /mock engine failure/.test(errT), errT);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
};

/* 4. Speaker models unavailable → transcription still succeeds */
suites.graceful = async (browser) => {
  const { ctx, page, errors } = await freshPage(browser);
  await page.evaluate(() => __mockEngines({ noSpeakers: true }));
  await page.setInputFiles('#file-input', path.join(MEDIA, 'burst_16k_s16_mono.wav'));
  check('finishes without speakers', await waitStatus(page, 'ready', 60000));
  const t = await page.evaluate(() => { const t = __vs.state.transcripts[0]; return { n: t.segments.length, spk: t.segments.map(s => s.spk), count: t.speakerCount }; });
  check('segments present, no speaker labels', t.n === 7 && t.spk.every(s => s == null) && !t.count, JSON.stringify(t));
  check('no speaker UI', (await page.$$('.seg-spk')).length === 0);
  // real worker boots (loads the engine source) even though the CDN is blocked here
  const boot = await page.evaluate(async () => {
    const E = __vs.engine.constructor; const e = new E('probe');
    try { await e._request({ type: 'ping' }); return 'booted'; } catch (err) { return 'error: ' + err.message; }
  });
  check('worker script boots and answers', boot === 'booted', boot);
  const load = await page.evaluate(async () => {
    const E = __vs.engine.constructor; const e = new E('probe2');
    try { await e.ensureLoaded('onnx-community/whisper-tiny'); return 'loaded'; } catch (err) { return err.message; }
  });
  check('blocked CDN gives a friendly engine error', /Could not download the AI engine/.test(load), load);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
};

/* 5. Recording with a fake microphone + live captions */
suites.recording = async (browser) => {
  const { ctx, page, errors } = await freshPage(browser);
  await page.evaluate(() => __mockEngines({}));
  await page.evaluate(() => App.setOpt('liveCaptions', true));
  await page.click('.rec-btn');
  await page.waitForSelector('#rec-timer', { timeout: 10000 });
  check('recording started', await page.evaluate(() => __vs.state.settings.recSource === 'mic' && document.querySelector('#live-cap') !== null));
  await page.waitForTimeout(13500);
  const live = await page.evaluate(() => ({ chunks: __calls.transcribe.length }));
  check('live caption chunk sent to engine', live.chunks >= 1, JSON.stringify(live));
  await page.click('text=Pause');
  check('paused state', (await page.textContent('.rec-state')).includes('paused'));
  await page.click('text=Resume');
  await page.click('text=Stop & transcribe');
  check('recording transcribed', await waitStatus(page, 'ready', 60000));
  const t = await page.evaluate(() => { const t = __vs.state.transcripts[0]; return { title: t.title, dur: t.durationSec, src: t.sourceName }; });
  check('recording saved as transcript', /^Recording/.test(t.title) && t.dur > 10 && t.dur < 20, JSON.stringify(t));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
};

/* 6. AI assistant: streamed SSE, chunked long transcripts, refusal */
suites.ai = async (browser) => {
  const { ctx, page, errors } = await freshPage(browser);
  await page.evaluate(() => __mockEngines({}));
  await page.setInputFiles('#file-input', path.join(MEDIA, 'burst_16k_s16_mono.wav'));
  await waitStatus(page, 'ready', 60000);
  const requests = [];
  await page.route('https://api.anthropic.com/v1/messages', async (route) => {
    const body = JSON.parse(route.request().postData());
    requests.push({ headers: route.request().headers(), body });
    const text = body.messages[0].content;
    const isMerge = /partial results/.test(text);
    const reply = isMerge ? 'MERGED(' + (text.match(/RESULT FOR PART/g) || []).length + ')' : 'OUT[' + text.length + ']';
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","usage":{}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' + reply.slice(0, 3) + '"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' + reply.slice(3) + '"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
  });
  await page.evaluate(() => App.setOpt('apiKey', 'sk-ant-test'));
  await page.evaluate(() => App.openAI(__vs.state.transcripts[0].id));
  await page.click('.chip[data-k="summary"]');
  await page.click('#ai-run');
  await page.waitForSelector('.ai-out', { timeout: 15000 });
  const aiText = await page.evaluate(() => __vs.state.transcripts[0].ai.text);
  check('single-request result saved and shown', /^OUT\[\d+\]$/.test(aiText) && (await page.textContent('.ai-out')).includes(aiText), aiText);
  const r0 = requests[0];
  check('uses Claude Opus 5, streaming, fallbacks', r0.body.model === 'claude-opus-5' && r0.body.stream === true && r0.body.fallbacks === 'default' && r0.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && r0.headers['anthropic-dangerous-direct-browser-access'] === 'true', JSON.stringify(r0.body.model));
  check('transcript with speakers sent', /Speaker 1: Burst at 1 seconds/.test(r0.body.messages[0].content));
  // long transcript → parts + merge
  await page.evaluate(async () => {
    const t = __vs.state.transcripts[0];
    t.segments = []; for (let i = 0; i < 9000; i++) t.segments.push({ start: i, end: i + 1, text: 'This is a fairly long sentence number ' + i + ' used to inflate the transcript for chunking tests, lorem ipsum dolor sit amet.', spk: i % 2 });
    await __vs.saveTranscript(t); App.go(''); App.go('t/' + t.id);
  });
  await page.waitForSelector('.tv-actions');
  requests.length = 0;
  await page.evaluate(() => App.openAI(__vs.state.transcripts[0].id));
  check('long transcript notice', (await page.textContent('.modal')).includes('processed in'));
  await page.click('.chip[data-k="minutes"]');
  await page.click('#ai-run');
  await page.waitForFunction(() => __vs.state.transcripts[0].ai && /^MERGED/.test(__vs.state.transcripts[0].ai.text), null, { timeout: 30000 });
  const merged = await page.evaluate(() => __vs.state.transcripts[0].ai.text);
  const parts = requests.length - 1;
  check('long transcript chunked then merged', parts >= 3 && merged === 'MERGED(' + parts + ')', merged + ' from ' + requests.length + ' requests');
  check('parts respect the chunk size', requests.slice(0, -1).every(r => r.body.messages[0].content.length < 360000));
  // map-only preset just concatenates
  requests.length = 0;
  await page.evaluate(() => App.openAI(__vs.state.transcripts[0].id));
  await page.click('.chip[data-k="clean"]');
  await page.click('#ai-run');
  await page.waitForFunction(() => __vs.state.transcripts[0].ai && /^OUT/.test(__vs.state.transcripts[0].ai.text), null, { timeout: 30000 });
  check('clean-up concatenates parts without a merge call', requests.length === parts && (await page.evaluate(() => __vs.state.transcripts[0].ai.text.split('\n\n').length)) === parts);
  // refusal
  await page.unroute('https://api.anthropic.com/v1/messages');
  await page.route('https://api.anthropic.com/v1/messages', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"other"}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n' }));
  await page.evaluate(async () => { const t = __vs.state.transcripts[0]; t.segments = t.segments.slice(0, 5); await __vs.saveTranscript(t); });
  await page.evaluate(() => App.openAI(__vs.state.transcripts[0].id));
  await page.click('#ai-run');
  await page.waitForFunction(() => /declined/.test(document.querySelector('#ai-status').textContent), null, { timeout: 10000 });
  check('refusal reported', true);
  // 401
  await page.unroute('https://api.anthropic.com/v1/messages');
  await page.route('https://api.anthropic.com/v1/messages', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"message":"invalid x-api-key"}}' }));
  await page.click('#ai-run');
  await page.waitForFunction(() => /rejected \(401\)/.test(document.querySelector('#ai-status').textContent), null, { timeout: 10000 });
  check('401 explained', true);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
};

/* 6b. Speaker clustering + filters inside the worker source */
suites.speakers = async (browser) => {
  const { ctx, page, errors } = await freshPage(browser);
  const r = await page.evaluate(() => {
    const fake = { postMessage() {}, navigator };
    new Function('self', document.getElementById('engine-src').textContent)(fake);
    const W = fake.__internals;
    // deterministic pseudo-random unit vectors
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const unit = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); return Float32Array.from(v, x => x / s); };
    const dim = 32, bases = [0, 1, 2].map(() => unit(Float32Array.from({ length: dim }, rnd)));
    const emb = (k, noise) => unit(Float32Array.from(bases[k], (x, i) => x + noise * rnd()));
    const out = {};
    // 3 speakers, 40 items each, interleaved in time; some without embeddings
    W.D.items.length = 0; W.D.segs.length = 0;
    for (let i = 0; i < 120; i++) {
      const k = i % 3, t0 = i * 10;
      W.D.items.push({ time: t0, emb: i % 17 === 5 ? null : emb(k, 0.35), dur: 3 + (i % 4) });
      W.D.segs.push({ start: t0, end: t0 + 4, item: i });
      W.D.segs.push({ start: t0 + 4.2, end: t0 + 6, item: i });   // gap < 0.4 s merges into one turn
    }
    const auto = W.finalizeSpeakers({ maxSpeakers: 0 });
    out.autoCount = auto.count;
    out.autoTurns = auto.turns.length;
    // every embedded item must land in the cluster of its ground-truth speaker (un-embedded ones follow a neighbour)
    const byTruth = [new Set(), new Set(), new Set()];
    auto.turns.forEach(t => { const i = Math.round(t.start / 10); if (W.D.items[i].emb) byTruth[i % 3].add(t.spk); });
    out.autoConsistent = byTruth.every(s => s.size === 1) && new Set(byTruth.map(s => [...s][0])).size === 3;
    out.firstIds = auto.turns.slice(0, 3).map(t => t.spk);
    out.merged = auto.turns.every(t => Math.abs((t.end - t.start) - 6) < 0.01);
    const two = W.finalizeSpeakers({ maxSpeakers: 2 });
    out.capCount = two.count;
    const one = W.finalizeSpeakers({ maxSpeakers: 1 });
    out.oneCount = one.count;
    out.oneAllSame = one.turns.every(t => t.spk === 0);
    // no embeddings at all → single speaker, no crash
    W.D.items.forEach(it => { it.emb = null; });
    const none = W.finalizeSpeakers({ maxSpeakers: 0 });
    out.noneOk = none.turns.length > 0 && none.turns.every(t => t.spk === 0);
    // hallucination filters
    out.hallu = W.isHallucinated('the the the the the the the the the the the the the the the the the the');
    out.notHallu = W.isHallucinated('This is a perfectly normal sentence with varied words in it, thank you very much.');
    out.boiler = ['Thanks for watching!', 'Subtitles by the Amara.org community', 'you', '...', '♪♪'].map(W.isBoilerplate);
    out.notBoiler = ['Thank you, that helps.', 'You should see this.'].map(W.isBoilerplate);
    return out;
  });
  check('auto clustering finds 3 speakers', r.autoCount === 3, r.autoCount);
  check('turns consistent with ground truth', r.autoConsistent);
  check('speakers numbered by first appearance', JSON.stringify(r.firstIds) === '[0,1,2]', JSON.stringify(r.firstIds));
  check('adjacent turns merged', r.merged && r.autoTurns === 120, r.autoTurns);
  check('maximum of 2 speakers respected', r.capCount === 2, r.capCount);
  check('single speaker cap', r.oneCount === 1 && r.oneAllSame);
  check('no embeddings handled', r.noneOk);
  check('hallucination loop detected', r.hallu === true && r.notHallu === false);
  check('boilerplate filtered', r.boiler.every(Boolean) && r.notBoiler.every(x => !x), JSON.stringify([r.boiler, r.notBoiler]));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
};

/* 7. Settings & misc UI */
suites.ui = async (browser) => {
  const { ctx, page, errors } = await freshPage(browser);
  check('home renders 4 option fields', (await page.$$('.opts-row .field')).length === 4);
  check('language list is complete', (await page.$$('#opt-lang option')).length >= 99);
  await page.selectOption('#opt-spk', '3');
  check('speaker option persists', await page.evaluate(() => __vs.state.settings.speakers === true && __vs.state.settings.maxSpeakers === 3));
  await page.selectOption('#opt-spk', 'off');
  check('speakers can be turned off', await page.evaluate(() => __vs.state.settings.speakers === false));
  await page.click('text=Settings');
  await page.waitForSelector('.modal');
  check('settings has advanced section', (await page.textContent('.modal')).includes('Custom Whisper model'));
  await page.click('details.adv summary');
  await page.fill('input[placeholder^="e.g. onnx-community"]', 'someone/whisper-finetune');
  await page.keyboard.press('Tab');
  await page.selectOption('.modal select', 'custom');
  check('custom model id used', await page.evaluate(() => window.__vs && __vs.state.settings.customModel === 'someone/whisper-finetune' && __vs.state.settings.quality === 'custom'));
  await page.click('.x-btn');
  await page.reload();
  await page.waitForFunction(() => window.__vs && document.querySelector('#dropzone'));
  check('settings persist across reload', await page.evaluate(() => __vs.state.settings.customModel === 'someone/whisper-finetune' && __vs.state.settings.speakers === false));
  await page.selectOption('.rec-opts select', 'mic+system');
  check('record source persists', await page.evaluate(() => __vs.state.settings.recSource === 'mic+system'));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
};

(async () => {
  // expose media over http for the long-file tests
  const link = path.join(__dirname, '..', '__media');
  try { fs.rmSync(link, { force: true }); } catch (e) {}
  fs.symlinkSync(MEDIA, link);
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const name of Object.keys(suites)) {
      if (filter && !name.includes(filter)) continue;
      results.push('▶ ' + name);
      const t0 = Date.now();
      try { await suites[name](browser); } catch (e) { failed++; results.push('  ✘ suite crashed: ' + (e.stack || e)); }
      results.push('  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
    }
  } finally {
    await browser.close();
    try { fs.unlinkSync(link); } catch (e) {}
  }
  console.log(results.join('\n'));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();

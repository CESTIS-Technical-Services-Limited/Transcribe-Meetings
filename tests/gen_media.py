import av, numpy as np, struct, sys, os
import os; OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'media'); os.makedirs(OUT, exist_ok=True)
def bursts(rate, seconds, chans=1, burst_times=None, burst_len=0.5, freq=1000.0, amp=0.5):
    n = int(rate * seconds); t = np.arange(n) / rate
    x = np.zeros(n, dtype=np.float32)
    for bt in (burst_times or []):
        a, b = int(bt * rate), int((bt + burst_len) * rate)
        x[a:b] = amp * np.sin(2 * np.pi * freq * t[a:b]).astype(np.float32)
    # low-level noise floor so silence detection isn't trivially fooled
    x += (np.random.RandomState(1).randn(n) * 0.0005).astype(np.float32)
    if chans == 1: return x.reshape(1, -1)
    return np.stack([x] + [x * 0.8 for _ in range(chans - 1)])

def write_wav(path, data, rate, bits=16, fmt='pcm'):
    chans, n = data.shape
    inter = data.T.reshape(-1)
    if fmt == 'float32': payload = inter.astype('<f4').tobytes(); tag = 3; bps = 4
    elif bits == 8: payload = (np.clip(inter * 127 + 128, 0, 255)).astype(np.uint8).tobytes(); tag = 1; bps = 1
    elif bits == 24:
        v = np.clip(inter * 8388607, -8388608, 8388607).astype(np.int32); b = v.astype('<i4').tobytes()
        payload = b''.join(b[i*4:i*4+3] for i in range(len(v))); tag = 1; bps = 3
    else: payload = np.clip(inter * 32767, -32768, 32767).astype('<i2').tobytes(); tag = 1; bps = 2
    ba = chans * bps
    hdr = b'RIFF' + struct.pack('<I', 36 + len(payload)) + b'WAVE' + b'fmt ' + struct.pack('<IHHIIHH', 16, tag, chans, rate, rate * ba, ba, bps * 8) + b'data' + struct.pack('<I', len(payload))
    open(path, 'wb').write(hdr + payload)

def write_av(path, data, rate, codec, fmt, bitrate=None, layout=None):
    chans = data.shape[0]
    c = av.open(path, 'w', format=fmt)
    s = c.add_stream(codec, rate=rate)
    s.layout = layout or ('mono' if chans == 1 else 'stereo')
    if bitrate: s.bit_rate = bitrate
    frame_size = s.codec_context.frame_size or 1024
    pcm = np.clip(data * 32767, -32768, 32767).astype('<i2')
    pos = 0; n = pcm.shape[1]
    while pos < n:
        chunk = pcm[:, pos:pos+frame_size]
        f = av.AudioFrame.from_ndarray(chunk.T.reshape(1, -1).copy() if chans>1 else chunk, format='s16', layout=s.layout.name)
        f.sample_rate = rate; f.pts = pos
        for p in s.encode(f): c.mux(p)
        pos += frame_size
    for p in s.encode(None): c.mux(p)
    c.close()

BT = [1.0, 5.0, 9.0, 13.0, 17.0, 21.0, 25.0]       # 28 s clips, bursts at these times
d441s = bursts(44100, 28, 2, BT); d16m = bursts(16000, 28, 1, BT); d48s = bursts(48000, 28, 2, BT); d11m = bursts(11025, 28, 1, BT)
write_wav(f'{OUT}/burst_44k_s16_stereo.wav', d441s, 44100, 16)
write_wav(f'{OUT}/burst_16k_s16_mono.wav', d16m, 16000, 16)
write_wav(f'{OUT}/burst_48k_s24_stereo.wav', d48s, 48000, 24)
write_wav(f'{OUT}/burst_48k_f32_stereo.wav', d48s, 48000, fmt='float32')
write_wav(f'{OUT}/burst_11k_u8_mono.wav', d11m, 11025, 8)
write_av(f'{OUT}/burst_44k_cbr128.mp3', d441s, 44100, 'libmp3lame', 'mp3', 128000)
write_av(f'{OUT}/burst_16k_mono.mp3', d16m, 16000, 'libmp3lame', 'mp3', 32000)
write_av(f'{OUT}/burst_44k.m4a', d441s, 44100, 'aac', 'ipod', 96000)
write_av(f'{OUT}/burst_48k.ogg', d48s, 48000, 'libopus', 'ogg', 64000)
write_av(f'{OUT}/burst_48k.webm', d48s, 48000, 'libopus', 'webm', 64000)
write_av(f'{OUT}/burst_44k.flac', d441s, 44100, 'flac', 'flac')
# ID3v2-tagged MP3 (prepend a fake 3000-byte ID3v2 tag) + ID3v1 trailer
raw = open(f'{OUT}/burst_44k_cbr128.mp3', 'rb').read()
size = 3000; ss = bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])
id3 = b'ID3' + bytes([3, 0, 0]) + ss + b'\x00' * size
open(f'{OUT}/burst_44k_id3.mp3', 'wb').write(id3 + raw + b'TAG' + b'\x00' * 125)
# long files: 40 minutes with bursts every 60 s (at t = 30, 90, 150, ...)
LONG = 40 * 60; LBT = [30.0 + 60 * k for k in range(40)]
dl = bursts(44100, LONG, 1, LBT)
write_av(f'{OUT}/long_40min.mp3', dl, 44100, 'libmp3lame', 'mp3', 64000)
write_wav(f'{OUT}/long_40min_16k.wav', bursts(16000, LONG, 1, LBT), 16000, 16)
print('done')

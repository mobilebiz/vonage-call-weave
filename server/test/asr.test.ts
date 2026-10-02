import { describe, expect, it } from 'vitest';
import { AmiVoiceAdapter } from '../src/media/asr/amivoice.js';
import { DeepgramAdapter } from '../src/media/asr/deepgram.js';
import { ElevenLabsAdapter } from '../src/media/asr/elevenlabs.js';
import type { AsrErrorInfo, AsrHandlers, AsrResult } from '../src/media/asr/types.js';

function recorder() {
  const ev: { t: string; r?: AsrResult; e?: AsrErrorInfo }[] = [];
  const h: AsrHandlers = {
    onReady: () => ev.push({ t: 'ready' }),
    onPartial: (r) => ev.push({ t: 'partial', r }),
    onFinal: (r) => ev.push({ t: 'final', r }),
    onError: (e) => ev.push({ t: 'error', e }),
    onClose: () => ev.push({ t: 'close' }),
  };
  return { ev, h };
}

describe('AmiVoice', () => {
  const opts = { url: 'wss://x', appKey: 'k', engine: '-a-general', resultUpdatedInterval: 500 };
  it('normalizes S/U/A events', () => {
    const { ev, h } = recorder();
    const a = new AmiVoiceAdapter(opts, h);
    a.onPacket('s');
    a.onPacket('S 1200');
    a.onPacket('U {"results":[{"text":"予約を"}],"text":"予約を"}');
    a.onPacket('E 2400');
    a.onPacket('A {"results":[{"text":"予約を変更したい。","starttime":1210,"endtime":2390}],"utteranceid":"u-1","text":"予約を変更したい。","code":"","message":""}');
    a.onPacket('S 5000');
    a.onPacket('U {"results":[{"text":"はい"}],"text":"はい"}');
    expect(ev.map((e) => e.t)).toEqual(['ready', 'partial', 'final', 'partial']);
    expect(ev[1]!.r).toMatchObject({ key: 'u1', text: '予約を', startMs: 1200 });
    expect(ev[2]!.r).toMatchObject({ key: 'u1', text: '予約を変更したい。', startMs: 1210, endMs: 2390, providerResultId: 'u-1' });
    expect(ev[3]!.r!.key).toBe('u2');
  });
  it('start failure is fatal', () => {
    const { ev, h } = recorder();
    new AmiVoiceAdapter(opts, h).onPacket('s authorization failed');
    expect(ev[0]).toMatchObject({ t: 'error', e: { fatal: true } });
  });
  it('A with error code closes the utterance as empty', () => {
    const { ev, h } = recorder();
    const a = new AmiVoiceAdapter(opts, h);
    a.onPacket('S 100');
    a.onPacket('A {"code":"-","message":"no speech","text":""}');
    expect(ev[0]).toMatchObject({ t: 'final', r: { text: '' } });
  });
});

describe('ElevenLabs', () => {
  const opts = { url: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime', apiKey: 'k', model: 'scribe_v2_realtime', language: 'ja', enableLogging: false, vadSilenceSecs: 0.8 };
  it('builds URL with pcm_16000 and ja', () => {
    const u = new URL(new ElevenLabsAdapter(opts, recorder().h).buildUrl());
    expect(u.searchParams.get('audio_format')).toBe('pcm_16000');
    expect(u.searchParams.get('language_code')).toBe('ja');
    expect(u.searchParams.get('model_id')).toBe('scribe_v2_realtime');
    expect(u.searchParams.get('enable_logging')).toBe('false');
  });
  it('late timestamps update the same utterance', () => {
    const { ev, h } = recorder();
    const a = new ElevenLabsAdapter(opts, h);
    a.onMessage('{"message_type":"session_started","session_id":"s"}');
    a.onMessage('{"message_type":"partial_transcript","text":"こんにち"}');
    a.onMessage('{"message_type":"committed_transcript","text":"こんにちは。"}');
    a.onMessage('{"message_type":"committed_transcript_with_timestamps","text":"こんにちは。","words":[{"text":"こんにちは","start":0.5,"end":1.2,"type":"word"}]}');
    a.onMessage('{"message_type":"partial_transcript","text":"次"}');
    const finals = ev.filter((e) => e.t === 'final');
    expect(finals.map((f) => f.r!.key)).toEqual(['u1', 'u1']);
    expect(finals[1]!.r).toMatchObject({ startMs: 500, endMs: 1200 });
    expect(ev.at(-1)!.r!.key).toBe('u2');
  });
  it('auth_error is fatal, others retryable, warnings ignored', () => {
    const { ev, h } = recorder();
    const a = new ElevenLabsAdapter(opts, h);
    a.onMessage('{"message_type":"auth_error","error":"bad key"}');
    a.onMessage('{"message_type":"transcriber_error","error":"x"}');
    a.onMessage('{"message_type":"commit_throttled","error":"x"}');
    expect(ev.map((e) => e.e?.fatal)).toEqual([true, false]);
  });
});

describe('Deepgram', () => {
  const opts = { url: 'wss://api.deepgram.com/v1/listen', apiKey: 'k', model: 'nova-3', language: 'ja', endpointingMs: 300, utteranceEndMs: 1000 };
  const res = (t: string, start: number, dur: number, f: { is_final?: boolean; speech_final?: boolean } = {}) =>
    JSON.stringify({ type: 'Results', start, duration: dur, ...f, channel: { alternatives: [{ transcript: t }] } });
  it('builds URL for nova-3 ja linear16 16k', () => {
    const u = new URL(new DeepgramAdapter(opts, recorder().h).buildUrl());
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ model: 'nova-3', language: 'ja', encoding: 'linear16', sample_rate: '16000', channels: '1', interim_results: 'true' });
  });
  it('is_final accumulates; speech_final commits', () => {
    const { ev, h } = recorder();
    const a = new DeepgramAdapter(opts, h);
    a.onMessage(res('予約', 1.0, 0.5));
    a.onMessage(res('予約を', 1.0, 0.8, { is_final: true }));
    a.onMessage(res('変更', 1.8, 0.4));
    a.onMessage(res('変更したい', 1.8, 0.9, { is_final: true, speech_final: true }));
    a.onMessage(res('はい', 4.0, 0.3));
    const kinds = ev.map((e) => `${e.t}:${e.r?.key}:${e.r?.text}`);
    expect(kinds).toEqual(['partial:u1:予約', 'partial:u1:予約を', 'partial:u1:予約を変更', 'final:u1:予約を変更したい', 'partial:u2:はい']);
    expect(ev[3]!.r).toMatchObject({ startMs: 1000, endMs: 2700 });
  });
  it('UtteranceEnd commits stable text', () => {
    const { ev, h } = recorder();
    const a = new DeepgramAdapter(opts, h);
    a.onMessage(res('もしもし', 0.2, 0.6, { is_final: true }));
    a.onMessage('{"type":"UtteranceEnd","last_word_end":0.8}');
    expect(ev.at(-1)).toMatchObject({ t: 'final', r: { text: 'もしもし' } });
  });
});

describe('ElevenLabs finalize', () => {
  const opts = { url: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime', apiKey: 'k', model: 'scribe_v2_realtime', language: 'ja', enableLogging: false, vadSilenceSecs: 0.8 };
  function withFakeSocket(a: ElevenLabsAdapter) {
    const sent: { commit: boolean }[] = [];
    (a as unknown as { ws: unknown }).ws = { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) };
    return sent;
  }
  it('commits on hangup when a later utterance only has a partial after an earlier late commit', async () => {
    const { h } = recorder();
    const a = new ElevenLabsAdapter(opts, h);
    const sent = withFakeSocket(a);
    a.onMessage('{"message_type":"committed_transcript","text":"A"}');
    a.onMessage('{"message_type":"partial_transcript","text":"B の途中"}');
    const p = a.finalize();
    expect(sent.at(-1)!.commit).toBe(true);
    a.onMessage('{"message_type":"committed_transcript","text":"B の途中です"}');
    await expect(p).resolves.toBeUndefined();
  });
  it('commit_throttled is retried and finally rejected, never treated as success', async () => {
    const { h } = recorder();
    const a = new ElevenLabsAdapter(opts, h);
    const sent = withFakeSocket(a);
    a.onMessage('{"message_type":"partial_transcript","text":"x"}');
    const p = a.finalize();
    let settled = false;
    p.catch(() => undefined).finally(() => (settled = true));
    for (let i = 0; i < 3; i++) {
      a.onMessage('{"message_type":"commit_throttled","error":"slow down"}');
      await new Promise((r) => setTimeout(r, 400 * (i + 1) + 20));
      expect(settled).toBe(false);
    }
    expect(sent.filter((m) => m.commit).length).toBe(4);
    a.onMessage('{"message_type":"commit_throttled","error":"slow down"}');
    await expect(p).rejects.toThrow(/throttled/);
  });
});

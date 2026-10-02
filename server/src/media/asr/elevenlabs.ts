// ElevenLabs Realtime Speech-to-Text（scribe_v2_realtime）。
// input_audio_chunk で Base64 PCM を送り、partial_transcript / committed_transcript(_with_timestamps) を受ける。
// https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
import WebSocket from 'ws';
import { BYTES_PER_MS, Chunker, SAMPLE_RATE, type AsrAdapter, type AsrHandlers } from './types.js';

export interface ElevenLabsOptions {
  url: string;
  apiKey: string;
  model: string;
  language: string;
  enableLogging: boolean;
  vadSilenceSecs: number;
}

const FATAL = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms', 'invalid_request']);
const IGNORE = new Set(['commit_throttled', 'insufficient_audio_activity', 'warning']);

interface ElMessage {
  message_type?: string;
  text?: string;
  error?: string;
  words?: { text?: string; start?: number; end?: number; type?: string }[] | null;
}

export class ElevenLabsAdapter implements AsrAdapter {
  readonly name = 'elevenlabs';
  private ws: WebSocket | null = null;
  private seq = 1;
  /** 最後の確定以降に音声を送ったか（途中結果が来ていなくても、未確定の音声がある） */
  private hasPending = false;
  /** 直前に確定した発話。後着のタイムスタンプ付き確定で同じ発話を更新する */
  private lastCommitted: { key: string; text: string } | null = null;
  private closing = false;
  private finalizeResolve: (() => void) | null = null;
  private chunker = new Chunker(100 * BYTES_PER_MS, (buf) => this.sendChunk(buf, false));

  constructor(
    private readonly opts: ElevenLabsOptions,
    private readonly h: AsrHandlers,
  ) {}

  buildUrl(): string {
    const u = new URL(this.opts.url);
    u.searchParams.set('model_id', this.opts.model);
    u.searchParams.set('audio_format', 'pcm_16000');
    u.searchParams.set('language_code', this.opts.language);
    u.searchParams.set('commit_strategy', 'vad');
    u.searchParams.set('include_timestamps', 'true');
    u.searchParams.set('vad_silence_threshold_secs', String(this.opts.vadSilenceSecs));
    // 契約によってはログ無効が適用されない。設定だけで無保存とは判断しない（仕様書 13 節）
    u.searchParams.set('enable_logging', String(this.opts.enableLogging));
    return u.toString();
  }

  async open(): Promise<void> {
    const ws = new WebSocket(this.buildUrl(), { headers: { 'xi-api-key': this.opts.apiKey } });
    this.ws = ws;
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      this.h.onError({ code: `elevenlabs_http_${code}`, fatal: code === 401 || code === 403 || code === 402 });
    });
    ws.on('error', (err) => this.h.onError({ code: 'elevenlabs_socket_error', fatal: false, message: err.message }));
    ws.on('close', () => {
      this.finalizeResolve?.();
      this.h.onClose(this.closing);
    });
  }

  private get key() {
    return `u${this.seq}`;
  }

  onMessage(raw: string) {
    let m: ElMessage;
    try {
      m = JSON.parse(raw) as ElMessage;
    } catch {
      return;
    }
    const type = m.message_type ?? '';
    switch (type) {
      case 'session_started':
        this.h.onReady();
        return;
      case 'partial_transcript': {
        const text = (m.text ?? '').trim();
        if (!text) return;
        // 後続発話の途中結果。先行発話の確定が遅れて届いても、未確定音声ありの状態を保つ
        this.hasPending = true;
        this.h.onPartial({ key: this.key, text });
        return;
      }
      case 'committed_transcript': {
        const text = (m.text ?? '').trim();
        this.lastCommitted = { key: this.key, text };
        this.h.onFinal({ key: this.key, text });
        this.seq++;
        this.hasPending = false;
        this.finalizeResolve?.();
        this.finalizeResolve = null;
        this.finalizeReject = null;
        return;
      }
      case 'committed_transcript_with_timestamps': {
        const words = (m.words ?? []).filter((w) => w.type !== 'spacing' && typeof w.start === 'number');
        const first = words[0];
        const last = words.at(-1);
        const text = (m.text ?? '').trim();
        const target = this.lastCommitted && this.lastCommitted.text === text ? this.lastCommitted.key : null;
        const key = target ?? this.key;
        this.h.onFinal({
          key,
          text,
          startMs: first?.start !== undefined ? Math.round(first.start * 1000) : undefined,
          endMs: last?.end !== undefined ? Math.round(last.end * 1000) : undefined,
        });
        if (!target) {
          this.seq++;
          this.hasPending = false;
        }
        this.finalizeResolve?.();
        this.finalizeResolve = null;
        this.finalizeReject = null;
        return;
      }
      default:
        if (IGNORE.has(type)) {
          // 確定させる音声が無い場合は、終話時の待機を終える
          if (type === 'insufficient_audio_activity') {
            this.finalizeResolve?.();
            this.finalizeResolve = null;
        this.finalizeReject = null;
          }
          // commit が間引かれた: 確定ではないので、終話処理中なら少し待って再送する
          if (type === 'commit_throttled' && this.finalizeResolve) this.retryCommit();
          return;
        }
        if (type === 'committed_transcript_entities' || type === 'edited_transcript') return;
        // auth_error / quota_exceeded などは再試行しない。それ以外のエラーは再接続対象
        if (FATAL.has(type) || m.error !== undefined) {
          this.h.onError({ code: `elevenlabs_${type || 'error'}`, fatal: FATAL.has(type), message: m.error });
        }
    }
  }

  writeAudio(pcm: Buffer) {
    this.chunker.push(pcm);
  }

  private sendChunk(buf: Buffer, commit: boolean) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (buf.length) this.hasPending = true;
    this.ws.send(
      JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: buf.toString('base64'), commit, sample_rate: SAMPLE_RATE }),
    );
  }

  private commitRetries = 0;
  private finalizeReject: ((e: Error) => void) | null = null;

  private retryCommit() {
    if (this.commitRetries >= 3) {
      // 確定できなかった。成功扱いにせず、呼出側で不完全として扱わせる
      this.finalizeReject?.(new Error('elevenlabs commit throttled'));
      this.finalizeResolve = null;
      this.finalizeReject = null;
      return;
    }
    this.commitRetries++;
    setTimeout(() => this.sendChunk(Buffer.alloc(0), true), 400 * this.commitRetries);
  }

  /** 残りの音声を確定させる。確定できなかった場合は reject（呼出側で不完全扱い） */
  finalize(): Promise<void> {
    this.chunker.flush();
    if (this.ws?.readyState !== WebSocket.OPEN || !this.hasPending) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.commitRetries = 0;
      this.finalizeResolve = resolve;
      this.finalizeReject = reject;
      // 手動 commit で残りの音声を確定させる
      this.sendChunk(Buffer.alloc(0), true);
    });
  }

  close() {
    this.closing = true;
    this.ws?.close();
  }
}

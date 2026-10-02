// Deepgram Live Streaming（Nova-3、日本語）。
// is_final は「その区間の部分確定」、speech_final / UtteranceEnd は「発話終了」。両者を同一視しない。
// https://developers.deepgram.com/docs/interim-results
import WebSocket from 'ws';
import { BYTES_PER_MS, Chunker, SAMPLE_RATE, type AsrAdapter, type AsrHandlers } from './types.js';

export interface DeepgramOptions {
  url: string;
  apiKey: string;
  model: string;
  language: string;
  endpointingMs: number;
  utteranceEndMs: number;
}

interface DgMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: { transcript?: string }[] };
}

export class DeepgramAdapter implements AsrAdapter {
  readonly name = 'deepgram';
  private ws: WebSocket | null = null;
  private seq = 1;
  /** 発話内で is_final になった区間 */
  private stable: string[] = [];
  private uStart: number | null = null;
  private uEnd: number | null = null;
  private closing = false;
  private keepAlive: NodeJS.Timeout | null = null;
  private lastSend = 0;
  private finalizeResolve: (() => void) | null = null;
  private chunker = new Chunker(100 * BYTES_PER_MS, (buf) => this.send(buf));
  private readonly sep: string;

  constructor(
    private readonly opts: DeepgramOptions,
    private readonly h: AsrHandlers,
  ) {
    // 日本語は単語間に空白を入れない
    this.sep = /^(ja|zh|ko)/.test(opts.language) ? '' : ' ';
  }

  buildUrl(): string {
    const u = new URL(this.opts.url);
    const q: Record<string, string> = {
      model: this.opts.model,
      language: this.opts.language,
      encoding: 'linear16',
      sample_rate: String(SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: String(this.opts.endpointingMs),
      utterance_end_ms: String(this.opts.utteranceEndMs),
      vad_events: 'true',
    };
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
  }

  async open(): Promise<void> {
    const ws = new WebSocket(this.buildUrl(), { headers: { Authorization: `Token ${this.opts.apiKey}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.h.onReady();
      this.keepAlive = setInterval(() => {
        if (Date.now() - this.lastSend > 4000 && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, 4000);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.onMessage(data.toString());
    });
    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      this.h.onError({ code: `deepgram_http_${code}`, fatal: code === 401 || code === 403 || code === 402 });
    });
    ws.on('error', (err) => this.h.onError({ code: 'deepgram_socket_error', fatal: false, message: err.message }));
    ws.on('close', () => {
      if (this.keepAlive) clearInterval(this.keepAlive);
      this.commit();
      this.finalizeResolve?.();
      this.h.onClose(this.closing);
    });
  }

  private get key() {
    return `u${this.seq}`;
  }

  private commit() {
    const text = this.stable.join(this.sep).trim();
    if (text) {
      this.h.onFinal({ key: this.key, text, startMs: this.uStart ?? undefined, endMs: this.uEnd ?? undefined });
      this.seq++;
    }
    this.stable = [];
    this.uStart = null;
    this.uEnd = null;
  }

  onMessage(raw: string) {
    let m: DgMessage;
    try {
      m = JSON.parse(raw) as DgMessage;
    } catch {
      return;
    }
    if (m.type === 'UtteranceEnd') {
      this.commit();
      return;
    }
    if (m.type !== 'Results') return;
    const transcript = (m.channel?.alternatives?.[0]?.transcript ?? '').trim();
    const startMs = Math.round((m.start ?? 0) * 1000);
    const endMs = Math.round(((m.start ?? 0) + (m.duration ?? 0)) * 1000);
    if (transcript && this.uStart === null) this.uStart = startMs;

    if (m.is_final) {
      if (transcript) {
        this.stable.push(transcript);
        this.uEnd = endMs;
      }
      if (m.speech_final || m.from_finalize) this.commit();
      else if (this.stable.length) {
        this.h.onPartial({ key: this.key, text: this.stable.join(this.sep), startMs: this.uStart ?? undefined });
      }
      return;
    }
    if (!transcript) return;
    const text = [...this.stable, transcript].join(this.sep);
    this.h.onPartial({ key: this.key, text, startMs: this.uStart ?? undefined });
  }

  writeAudio(pcm: Buffer) {
    this.chunker.push(pcm);
  }

  private send(buf: Buffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(buf);
    this.lastSend = Date.now();
  }

  finalize(): Promise<void> {
    this.chunker.flush();
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => {
      this.finalizeResolve = resolve;
      // Finalize で残りを確定させ、CloseStream で最終結果送出後にサーバーが閉じる
      this.ws!.send(JSON.stringify({ type: 'Finalize' }));
      this.ws!.send(JSON.stringify({ type: 'CloseStream' }));
      this.closing = true;
    });
  }

  close() {
    this.closing = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.ws?.close();
  }
}

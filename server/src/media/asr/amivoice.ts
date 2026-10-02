// AmiVoice API（Cloud Platform）WebSocket インタフェース。
// s コマンドで開始 → p + PCM で音声送信 → e で終了。S/E/U/A イベントを正規化する。
// https://docs.amivoice.com/amivoice-api/manual/websocket-interface-command-and-response
import WebSocket from 'ws';
import { BYTES_PER_MS, Chunker, type AsrAdapter, type AsrHandlers } from './types.js';

export interface AmiVoiceOptions {
  url: string;
  appKey: string;
  engine: string;
  resultUpdatedInterval: number;
}

interface AmiResultJson {
  text?: string;
  code?: string;
  message?: string;
  utteranceid?: string;
  results?: { text?: string; starttime?: number; endtime?: number }[];
}

export class AmiVoiceAdapter implements AsrAdapter {
  readonly name = 'amivoice';
  private ws: WebSocket | null = null;
  private seq = 0;
  private current: { key: string; startMs?: number; endMs?: number } | null = null;
  private closing = false;
  private finalizeResolve: (() => void) | null = null;
  private chunker = new Chunker(100 * BYTES_PER_MS, (buf) => this.sendAudio(buf));

  constructor(
    private readonly opts: AmiVoiceOptions,
    private readonly h: AsrHandlers,
  ) {}

  async open(): Promise<void> {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.on('open', () => {
      // 16kHz 16bit LE PCM は LSB16K
      const params = [`s LSB16K ${this.opts.engine}`, `authorization=${this.opts.appKey}`];
      if (this.opts.resultUpdatedInterval > 0) params.push(`resultUpdatedInterval=${this.opts.resultUpdatedInterval}`);
      ws.send(params.join(' '));
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.onPacket(data.toString());
    });
    ws.on('error', (err) => this.h.onError({ code: 'amivoice_socket_error', fatal: false, message: err.message }));
    ws.on('close', () => {
      this.finalizeResolve?.();
      this.h.onClose(this.closing);
    });
  }

  /** テストから直接呼べるよう公開 */
  onPacket(packet: string) {
    const type = packet[0];
    const rest = packet.length > 2 ? packet.slice(2) : '';
    switch (type) {
      case 's':
        if (rest) this.h.onError({ code: 'amivoice_start_failed', fatal: true, message: rest });
        else this.h.onReady();
        break;
      case 'p':
        if (rest) this.h.onError({ code: 'amivoice_audio_rejected', fatal: false, message: rest });
        break;
      case 'e':
        if (rest) this.h.onError({ code: 'amivoice_end_failed', fatal: false, message: rest });
        this.finalizeResolve?.();
        this.finalizeResolve = null;
        break;
      case 'S': {
        this.current = { key: `u${++this.seq}`, startMs: Number(rest) || undefined };
        break;
      }
      case 'E':
        if (this.current) this.current.endMs = Number(rest) || undefined;
        break;
      case 'U':
      case 'A': {
        let json: AmiResultJson;
        try {
          json = JSON.parse(rest) as AmiResultJson;
        } catch {
          return;
        }
        if (type === 'A' && json.code) {
          // 認識失敗（無音・音声不良など）。発話は空として確定させる
          if (this.current) this.h.onFinal({ key: this.current.key, text: '' });
          this.current = null;
          return;
        }
        this.current ??= { key: `u${++this.seq}` };
        const r0 = json.results?.[0];
        const result = {
          key: this.current.key,
          text: (json.text ?? r0?.text ?? '').trim(),
          startMs: r0?.starttime ?? this.current.startMs,
          endMs: r0?.endtime ?? this.current.endMs,
          providerResultId: json.utteranceid,
        };
        if (type === 'U') this.h.onPartial(result);
        else {
          this.h.onFinal(result);
          this.current = null;
        }
        break;
      }
      default:
        break; // C, G などは表示に使わない
    }
  }

  writeAudio(pcm: Buffer) {
    this.chunker.push(pcm);
  }

  private sendAudio(buf: Buffer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(Buffer.concat([Buffer.from('p'), buf]));
  }

  finalize(): Promise<void> {
    this.chunker.flush();
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => {
      this.finalizeResolve = resolve;
      this.ws!.send('e');
    });
  }

  close() {
    this.closing = true;
    this.ws?.close();
  }
}

// 音声認識アダプターの共通インターフェース。
// 入力は 16kHz / 16bit signed LE / mono PCM。時刻は「このセッションに送った音声の先頭」からの ms。

export interface AsrResult {
  /** セッション内で発話を識別するキー。同じキーの partial は置換、final で確定 */
  key: string;
  text: string;
  startMs?: number;
  endMs?: number;
  providerResultId?: string;
}

export interface AsrErrorInfo {
  code: string;
  /** true なら再試行しない（認証失敗・上限超過など） */
  fatal: boolean;
  message?: string;
}

export interface AsrHandlers {
  onReady(): void;
  onPartial(r: AsrResult): void;
  onFinal(r: AsrResult): void;
  onError(e: AsrErrorInfo): void;
  /** 接続が閉じた。expected=false は予期しない切断 */
  onClose(expected: boolean): void;
}

export interface AsrAdapter {
  readonly name: string;
  open(): Promise<void>;
  writeAudio(pcm: Buffer): void;
  /** 残りの音声の認識を確定させる。ベンダーの完了通知で resolve（タイムアウトは呼出側） */
  finalize(): Promise<void>;
  close(): void;
}

export const SAMPLE_RATE = 16000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // 32

/** 小さな音声フレームを一定サイズにまとめて送る */
export class Chunker {
  private parts: Buffer[] = [];
  private size = 0;
  constructor(
    private readonly targetBytes: number,
    private readonly flushFn: (buf: Buffer) => void,
  ) {}
  push(buf: Buffer) {
    this.parts.push(buf);
    this.size += buf.length;
    if (this.size >= this.targetBytes) this.flush();
  }
  flush() {
    if (!this.size) return;
    const buf = Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    this.flushFn(buf);
  }
}

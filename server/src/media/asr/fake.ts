// ローカル検証用の擬似エンジン。受け取った音声量（=時間）に合わせて定型文を途中結果→確定で出す。
// 本番では使用禁止（config で拒否）。
import { BYTES_PER_MS, type AsrAdapter, type AsrHandlers } from './types.js';
import type { Role } from '../../shared/types.js';

const LINES: Record<Role, string[]> = {
  caller: [
    'もしもし、予約の件でお電話しました。',
    '来週の火曜日の予約を、水曜日に変更したいのですが。',
    '午後二時ごろだと助かります。',
    'はい、それでお願いします。ありがとうございました。',
  ],
  operator: [
    'お電話ありがとうございます。担当の者です。',
    'ご予約の変更ですね。お名前を伺ってもよろしいでしょうか。',
    '水曜日の午後二時でしたらお取りできます。',
    'かしこまりました。変更を承りました。',
  ],
};

export class FakeAdapter implements AsrAdapter {
  readonly name = 'fake';
  private receivedMs = 0;
  private seq = 0;
  private ready = false;
  private closed = false;
  private open_: { key: string; line: string; startMs: number } | null = null;

  constructor(
    private readonly role: Role,
    private readonly h: AsrHandlers,
    private readonly engineLabel: string,
  ) {}

  async open() {
    setTimeout(() => {
      if (this.closed) return;
      this.ready = true;
      this.h.onReady();
    }, 300);
  }

  /** 話者ごとに位相をずらし、4 秒ごとに 1 発話。2.5 秒間かけて途中結果を伸ばす */
  writeAudio(pcm: Buffer) {
    if (!this.ready) return;
    const before = this.receivedMs;
    this.receivedMs += pcm.length / BYTES_PER_MS;
    const period = 4000;
    const offset = this.role === 'caller' ? 500 : 2500;
    const cycle = Math.floor((this.receivedMs - offset) / (period * 2));
    if (this.receivedMs < offset) return;
    const pos = (this.receivedMs - offset) % (period * 2);
    const prevPos = (before - offset) % (period * 2);
    const lines = LINES[this.role];
    const line = `${lines[cycle % lines.length]}（${this.engineLabel}）`;
    const key = `u${cycle}`;
    const startMs = offset + cycle * period * 2;
    if (pos < 2500) {
      const shown = Math.max(1, Math.round((line.length * pos) / 2500));
      if (Math.floor(pos / 300) !== Math.floor(prevPos / 300) || prevPos > pos) {
        this.h.onPartial({ key, text: line.slice(0, shown), startMs });
        this.open_ = { key, line, startMs };
      }
    } else if (prevPos < 2500) {
      this.seq = cycle;
      this.h.onFinal({ key, text: line, startMs, endMs: startMs + 2500, providerResultId: `fake-${this.seq}` });
      this.open_ = null;
    }
  }

  /** 実エンジン同様、終了時に発話途中の結果を確定させる */
  async finalize() {
    const o = this.open_;
    if (!o) return;
    this.open_ = null;
    this.h.onFinal({ key: o.key, text: o.line, startMs: o.startMs, endMs: this.receivedMs, providerResultId: `fake-final-${o.key}` });
  }

  close() {
    this.closed = true;
    this.h.onClose(true);
  }
}

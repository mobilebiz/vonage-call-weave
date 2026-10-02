// NCCO の組み立て。IVR 文言・呼制御の手順は docs/ncco-flow.md を参照。
import { ENGINE_LABEL, type Engine } from '../shared/types.js';

const VOICE = { language: 'ja-JP', style: 0 };

export const IVR_PROMPT =
  '音声認識エンジンを選択してください。AmiVoiceは1、ElevenLabsは2、Deepgramは3を押してください。';
export const IVR_RETRY_PROMPT = '入力を確認できませんでした。' + IVR_PROMPT;
export const IVR_GIVE_UP = '選択を確認できなかったため、お電話を終了します。恐れ入りますが、おかけ直しください。';
export const DIAL_FAILED = '申し訳ございません。ただいま担当者におつなぎできません。時間をおいておかけ直しください。';

export function ivrNcco(inputUrl: string, retry: boolean): unknown[] {
  return [
    { action: 'talk', text: retry ? IVR_RETRY_PROMPT : IVR_PROMPT, bargeIn: true, ...VOICE },
    {
      action: 'input',
      type: ['dtmf'],
      dtmf: { maxDigits: 1, timeOut: 10, submitOnHash: false },
      eventUrl: [inputUrl],
      eventMethod: 'POST',
    },
  ];
}

export function connectCallerNcco(opts: {
  engine: Engine;
  conversationName: string;
  holdMusicUrl: string | null;
}): unknown[] {
  return [
    { action: 'talk', text: `${ENGINE_LABEL[opts.engine]}で文字起こしします。担当者におつなぎします。`, ...VOICE },
    {
      action: 'conversation',
      name: opts.conversationName,
      // 保留音を使う場合は SIP レッグ参加まで会話を開始しない
      startOnEnter: opts.holdMusicUrl ? false : true,
      ...(opts.holdMusicUrl ? { musicOnHoldUrl: [opts.holdMusicUrl] } : {}),
      endOnExit: true,
    },
  ];
}

export function talkAndEndNcco(text: string): unknown[] {
  return [{ action: 'talk', text, ...VOICE }];
}

/** SIP レッグ: 発信者だけを聞く。監視 WS は canSpeak: [] のため元々聞こえない */
export function sipLegNcco(conversationName: string, callerUuid: string): unknown[] {
  return [
    {
      action: 'conversation',
      name: conversationName,
      canHear: [callerUuid],
      startOnEnter: true,
      endOnExit: true,
    },
  ];
}

/** 監視 WS レッグ: 対象レッグだけを聞き、誰にも音声を送らない */
export function monitorLegNcco(conversationName: string, targetUuid: string): unknown[] {
  return [
    {
      action: 'conversation',
      name: conversationName,
      canHear: [targetUuid],
      canSpeak: [],
      startOnEnter: true,
      endOnExit: false,
    },
  ];
}

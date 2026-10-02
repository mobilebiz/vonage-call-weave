import type { Config } from '../../config.js';
import { ENGINE_LABEL, type Engine, type Role } from '../../shared/types.js';
import { AmiVoiceAdapter } from './amivoice.js';
import { DeepgramAdapter } from './deepgram.js';
import { ElevenLabsAdapter } from './elevenlabs.js';
import { FakeAdapter } from './fake.js';
import type { AsrAdapter, AsrHandlers } from './types.js';

export type AsrFactory = (engine: Engine, role: Role, handlers: AsrHandlers) => AsrAdapter;

export function createAsrFactory(cfg: Config): AsrFactory {
  const a = cfg.asr;
  return (engine, role, h) => {
    if (a.fake) return new FakeAdapter(role, h, ENGINE_LABEL[engine]);
    switch (engine) {
      case 'amivoice':
        return new AmiVoiceAdapter(a.amivoice, h);
      case 'elevenlabs':
        return new ElevenLabsAdapter({ ...a.elevenlabs, language: a.language }, h);
      case 'deepgram':
        return new DeepgramAdapter({ ...a.deepgram, language: a.language }, h);
    }
  };
}

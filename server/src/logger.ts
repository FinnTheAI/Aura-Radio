import { config } from './config.js';

const order: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function level(): number {
  return order[config.logLevel] ?? 20;
}

export const log = {
  debug: (...a: unknown[]) => {
    if (level() <= 10) console.debug('[aura]', ...a);
  },
  info: (...a: unknown[]) => {
    if (level() <= 20) console.info('[aura]', ...a);
  },
  warn: (...a: unknown[]) => {
    if (level() <= 30) console.warn('[aura]', ...a);
  },
  error: (...a: unknown[]) => {
    if (level() <= 40) console.error('[aura]', ...a);
  },
};

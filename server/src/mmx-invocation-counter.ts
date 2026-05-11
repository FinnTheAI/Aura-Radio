/**
 * Claude 单次 generateDjScript 会话内 mmx-cli search 计数（供 gate 与清理）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function mmxInvocationCounterPath(invocationId: string): string {
  const safe = invocationId.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 200);
  return path.join(os.tmpdir(), `aura-mmx-inv-${safe}.json`);
}

export function unlinkMmxInvocationFile(invocationId: string): void {
  try {
    fs.unlinkSync(mmxInvocationCounterPath(invocationId));
  } catch {
    /** */
  }
}

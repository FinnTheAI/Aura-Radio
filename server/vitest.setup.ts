import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-vitest-'));
process.env.STATE_DB_PATH = path.join(tmp, 'state.db');
/** `/api/chat` 内不跑重型 NCM 候选池（contract 测试需快速） */
process.env.AURA_SKIP_NCM_CANDIDATES = '1';
/** 避免 contract 测试调用本地 Claude / 外网 MiniMax 导致超时 */
process.env.BRAIN_MOCK = '1';

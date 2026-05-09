import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-vitest-'));
process.env.STATE_DB_PATH = path.join(tmp, 'state.db');

/**
 * Claude Bash 允许的 mmx-cli 唯一入口：校验子命令 → 写审计 → spawn npx mmx-cli。
 * 用法：
 *   MINIMAX_API_KEY=*** node ".../dist/tools/mmx-cli-gate.js" search query "关键词" --output json
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mmxGateAuditBegin, mmxGateAuditComplete } from '../db.js';
import { mmxInvocationCounterPath } from '../mmx-invocation-counter.js';
import { config } from '../config.js';

function readSearchCount(pathname: string): number {
  try {
    const j = JSON.parse(fs.readFileSync(pathname, 'utf8')) as { c?: number };
    return typeof j.c === 'number' && Number.isFinite(j.c) ? Math.max(0, Math.floor(j.c)) : 0;
  } catch {
    return 0;
  }
}

function bumpSearchCount(pathname: string): void {
  const c = readSearchCount(pathname) + 1;
  fs.writeFileSync(pathname, JSON.stringify({ c }), 'utf8');
}

function checkMmxSearchBudget(rest: string[]): boolean {
  if (rest[0] !== 'search') return true;
  const inv = (process.env.AURA_MMX_INVOCATION_ID ?? '').trim();
  if (!inv) return true;
  const max = config.mmxMaxSearchPerInvocation;
  const p = mmxInvocationCounterPath(inv);
  const n = readSearchCount(p);
  if (n >= max) {
    console.error(
      `[mmx-cli-gate] AURA_MMX_SEARCH_LIMIT: invocation already used ${n}/${max} search(es). No more mmx-cli search in this Brain call.`,
    );
    return false;
  }
  return true;
}

function usage(): void {
  console.error(
    '用法: MINIMAX_API_KEY=*** node mmx-cli-gate.js <search … | text chat … | chat …>',
  );
  process.exit(2);
}

function validateArgv(rest: string[]): boolean {
  if (rest.length === 0) return false;
  if (rest[0] === 'search') return true;
  if (rest[0] === 'chat') return true;
  if (rest[0] === 'text' && rest[1] === 'chat') return true;
  return false;
}

/** 只允许 npx 形式的 mmx 子命令头（与设计文档正则一致） */
const NPX_ALLOW = /^npx\s+(-y\s+)?mmx-cli\s+((?:search\b)|(?:text\s+chat\b)|(?:chat\b))(\s|$)/i;

function validateNpxSafety(joined: string): boolean {
  return NPX_ALLOW.test(joined.trim());
}

function main(): void {
  const rest = process.argv.slice(2);
  if (!validateArgv(rest)) usage();

  const npxForm = `npx -y mmx-cli ${rest.join(' ')}`;
  if (!validateNpxSafety(npxForm)) usage();

  if (!checkMmxSearchBudget(rest)) {
    process.exit(77);
  }

  const cmdStr = npxForm.slice(0, 2048);
  const auditId = mmxGateAuditBegin(cmdStr);
  const t0 = Date.now();

  const r = spawnSync('npx', ['-y', 'mmx-cli', ...rest], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
    shell: process.platform === 'win32',
  });

  const exit = r.status ?? 1;
  const out = r.stdout ?? '';
  const err = r.stderr ?? '';

  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);

  mmxGateAuditComplete(auditId, exit === 0, exit, out, err, Date.now() - t0);
  if (exit === 0 && rest[0] === 'search') {
    const inv = (process.env.AURA_MMX_INVOCATION_ID ?? '').trim();
    if (inv) {
      try {
        bumpSearchCount(mmxInvocationCounterPath(inv));
      } catch {
        /** */
      }
    }
  }
  process.exit(exit);
}

main();

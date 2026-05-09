/**
 * 点播意图：从自然语言抽出关键字后，经由 `ncma.ts` 的 `ncmSearch` 拉歌并入队。
 *
 * **重要**：npm 发布的 `@music163/ncm-cli`（例如 0.1.x）**没有**稳定的 `search` 子命令可给服务端 spawn；
 * 文档/PDF 里出现的 `search` 与公开发行版不一致。本机 **`ncm-cli` 仍可**用于 Skills / `play`/`tui`，
 * 但 **Aura Server 不负责** CLI 检索；若要「播放晴天」对上真实曲库，需配置 **`NCM_API_BASE_URL`**
 *（或其它与 `ncmSearch` 兼容的数据源）。
 */

import { ncmSearch } from './ncma.js';

export interface CliSongHit {
  ncmSongId: string;
  name: string;
  artists: string[];
}

/** 形如「播放周杰伦 晴天」「点播 晴天」→ 关键字 */
export function extractPlayKeyword(userText: string): string | null {
  const t = userText.replace(/\u3000/g, ' ').trim();
  if (!t) return null;
  const prefixes =
    /^(?:播放(?:一下|吧)?|点播|帮我放|帮我播|给我放|来一首|放一首|放首歌|听听|播放)\s*[「『"'【\[]?/i;
  const stripped = t.replace(prefixes, '').trim();
  if (!stripped || stripped === t) return null;
  return stripped.replace(/[」』"'】\]]\s*$/, '').trim() || null;
}

function pushSongRow(o: Record<string, unknown>, out: CliSongHit[]) {
  const oid = (o.originalId ?? o.original_id ?? o.originalid) as unknown;
  if (typeof oid !== 'number' && typeof oid !== 'string') return;
  const id = String(oid).trim();
  if (!/^\d+$/.test(id)) return;
  const name = typeof o.name === 'string' ? o.name : '未知曲目';
  const artists: string[] = [];
  const ar = o.artists;
  if (Array.isArray(ar)) {
    for (const a of ar) {
      if (a && typeof a === 'object' && typeof (a as { name?: string }).name === 'string')
        artists.push((a as { name: string }).name);
    }
  }
  out.push({ ncmSongId: id, name, artists });
}

/** 若将来仍需解析 CLI/其它 JSON，`originalId` 形态的结果可复用此逻辑。 */
export function hitsFromCliStdoutJson(parsed: unknown): CliSongHit[] {
  const out: CliSongHit[] = [];
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    const r = v as Record<string, unknown>;
    if ('originalId' in r || 'original_id' in r) {
      pushSongRow(r, out);
      return;
    }
    for (const k of ['songs', 'songList', 'list', 'items', 'data', 'result', 'records'] as const) {
      const x = r[k];
      if (Array.isArray(x)) {
        for (const row of x) visit(row);
      } else if (x && typeof x === 'object') {
        visit(x);
      }
    }
  };

  visit(parsed);
  const seen = new Set<string>();
  return out.filter((h) => (seen.has(h.ncmSongId) ? false : (seen.add(h.ncmSongId), true)));
}

/**
 * 检索可入队条目：调用 `ncma.ncmSearch`（需 **`NCM_API_BASE_URL`** 才与关键字一致；mock 时为占位列表）。
 */
export async function searchSongHitsForPlayIntent(keyword: string, limit = 8): Promise<CliSongHit[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const capped = Math.min(Math.max(limit, 1), 20);
  const metas = await ncmSearch(kw, capped);
  return metas.map((m) => ({
    ncmSongId: m.id,
    name: m.name,
    artists: m.artists,
  }));
}

/** @deprecated 曾误用 npm 上不存在的 `ncm-cli search`；等价于 {@link searchSongHitsForPlayIntent} */
export const searchSongsViaNeteaseCli = searchSongHitsForPlayIntent;

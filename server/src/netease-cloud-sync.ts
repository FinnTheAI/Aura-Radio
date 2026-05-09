import path from 'node:path';
import { config, mergeNcmCookies } from './config.js';
import type { CloudFavoriteRowDb, CloudHistoryRowDb } from './db.js';
import { replaceCloudData } from './db.js';
import { log } from './logger.js';
import {
  ncmFetchRecentSongList,
  ncmFetchUserPlaylistSummaries,
  ncmLikelistSongIds,
  ncmPlaylistTrackRows,
  ncmResolveUserId,
  ncmSongDetailRichMany,
} from './ncma.js';

const MAX_PLAYLISTS = 24;
const MAX_TRACKS_PER_PLAYLIST = 200;
const RECENT_CAP = 300;

function dedupeFavorites(rows: Omit<CloudFavoriteRowDb, 'synced_at'>[]): Omit<CloudFavoriteRowDb, 'synced_at'>[] {
  const seen = new Set<string>();
  const out: Omit<CloudFavoriteRowDb, 'synced_at'>[] = [];
  for (const r of rows) {
    const k = `${r.ncm_song_id}\t${r.source}\t${r.playlist_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** 可走私有接口：`NCM_MOCK=0`、`NCM_API_BASE_URL`、`MUSIC_U` 或 `NCM_UPSTREAM_COOKIE`。 */
export function neteaseCloudSyncEligible(): boolean {
  return Boolean(!config.ncmMock && config.ncmApiBaseUrl && mergeNcmCookies().length > 0);
}

async function fetchFavoriteRows(uid: string): Promise<Omit<CloudFavoriteRowDb, 'synced_at'>[]> {
  const favorites: Omit<CloudFavoriteRowDb, 'synced_at'>[] = [];

  const likeIds = await ncmLikelistSongIds(uid);
  const likeRich = await ncmSongDetailRichMany(likeIds);
  for (const id of likeIds) {
    const r = likeRich.get(id);
    favorites.push({
      ncm_song_id: id,
      song_name: r?.name ?? null,
      artists_json: JSON.stringify(r?.artists ?? []),
      tags_json: JSON.stringify([...(r?.tags ?? []), '来源:喜欢的音乐']),
      source: 'likelist',
      playlist_id: '',
      playlist_name: null,
    });
  }

  const pls = (await ncmFetchUserPlaylistSummaries(uid)).filter((p) => p.subscribed === true).slice(0, MAX_PLAYLISTS);
  for (const pl of pls) {
    const tracks = await ncmPlaylistTrackRows(pl.id, MAX_TRACKS_PER_PLAYLIST);
    for (const tr of tracks) {
      favorites.push({
        ncm_song_id: tr.id,
        song_name: tr.name,
        artists_json: JSON.stringify(tr.artists),
        tags_json: JSON.stringify([...tr.tags, `来源:收藏歌单`, `歌单:${pl.name}`]),
        source: 'playlist_collected',
        playlist_id: pl.id,
        playlist_name: pl.name,
      });
    }
  }

  return favorites;
}

async function fetchHistoryRows(): Promise<Omit<CloudHistoryRowDb, 'synced_at'>[]> {
  const recent = await ncmFetchRecentSongList(RECENT_CAP);
  return recent.map((r) => {
    const hod =
      typeof r.playTs === 'number' && r.playTs > 1e11
        ? new Date(r.playTs).getHours()
        : null;
    return {
      ncm_song_id: r.id,
      song_name: r.name,
      artists_json: JSON.stringify(r.artists),
      tags_json: JSON.stringify([...r.tags, '来源:最近播放']),
      play_ts: r.playTs ?? null,
      hour_of_day: hod,
      source: 'recent_listen',
    };
  });
}

/**
 * 从网易云读取收藏/歌单曲目与最近收听，重写 `cloud_favorites` / `cloud_history`。
 * 需在 `.env` 配置 `NCM_API_BASE_URL` + `NCM_MOCK=0` + `MUSIC_U`（或与 `NETEASE_UID`）。
 */
export async function syncNeteaseCloudToSqlite(): Promise<{
  ok: boolean;
  favorites: number;
  history: number;
  message?: string;
}> {
  if (!neteaseCloudSyncEligible()) {
    const msg =
      !config.ncmApiBaseUrl || config.ncmMock
        ? '需要 NCM_API_BASE_URL + NCM_MOCK=0'
        : '缺少登录 Cookie：请在 .env 配置 MUSIC_U 或 NCM_UPSTREAM_COOKIE';
    return { ok: false, favorites: 0, history: 0, message: msg };
  }

  const uid = await ncmResolveUserId();
  if (!uid) {
    return {
      ok: false,
      favorites: 0,
      history: 0,
      message: '无法解析 UID：请在 .env 设置 NETEASE_UID，或确认 Cookie 可访问 /user/account',
    };
  }

  const t0 = Date.now();
  const favDraftRaw = await fetchFavoriteRows(uid);
  const favDraftDedup = dedupeFavorites(favDraftRaw);
  const histDraft = await fetchHistoryRows();

  replaceCloudData(favDraftDedup, histDraft);

  log.info('[cloud-sync]', {
    uid,
    favorites: favDraftDedup.length,
    history: histDraft.length,
    ms: Date.now() - t0,
  });

  return { ok: true, favorites: favDraftDedup.length, history: histDraft.length };
}

export function tasteCloudMarkdownPath(): string {
  return path.join(config.userDataDir, 'taste-cloud.md');
}

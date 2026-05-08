import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
/** 外链 http(s) 音频通过同源代理供 MediaElementSource 使用；相对路径 / data URL 不代理。 */
export function proxiedPlaybackUrl(originalUrl: string | undefined): string | undefined {
  if (!originalUrl) return undefined;
  const t = originalUrl.trim();
  if (!t.startsWith('http://') && !t.startsWith('https://')) return undefined;
  return `/api/audio/proxy?url=${encodeURIComponent(t)}`;
}

export function applyProxiedPlaybackUrl<T extends { url?: string }>(
  obj: T,
): T & { proxiedUrl?: string } {
  const proxiedUrl = proxiedPlaybackUrl(obj.url);
  return proxiedUrl ? { ...obj, proxiedUrl } : { ...obj };
}

const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
] as const;

export async function handleAudioProxyGet(req: Request, res: Response): Promise<void> {
  const rawUrl = req.query.url;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    res.status(400).json({ error: 'url required' });
    return;
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      res.status(400).json({ error: 'invalid url' });
      return;
    }
  } catch {
    res.status(400).json({ error: 'invalid url' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    const headers: Record<string, string> = { 'User-Agent': 'AuraRadioAudioProxy/1.0' };
    const range = req.headers.range;
    if (typeof range === 'string') headers.Range = range;

    upstream = await fetch(target.href, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    if (!res.headersSent) res.status(502).json({ error: 'upstream unreachable or timeout' });
    return;
  }
  clearTimeout(timer);

  const status = upstream.status;
  if (status >= 400) {
    const snippet = await upstream.text().catch(() => '');
    if (!res.headersSent)
      res.status(status >= 500 ? 502 : status).send(snippet.slice(0, 4096));
    return;
  }

  if (!(status === 200 || status === 206)) {
    if (!res.headersSent) res.status(502).end();
    return;
  }

  for (const name of PASSTHROUGH_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) res.setHeader(name, v);
  }
  res.status(status);

  const body = upstream.body;
  if (!body) {
    res.end();
    return;
  }

  const nodeReadable = Readable.fromWeb(body as import('stream/web').ReadableStream);
  req.on('close', () => nodeReadable.destroy());
  nodeReadable.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  nodeReadable.pipe(res);
}

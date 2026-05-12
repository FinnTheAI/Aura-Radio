/**
 * 建筑空间底图：从 Ref/Background（或 BACKGROUND_REF_DIR）随机提供静态图。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { config } from './config.js';
import { log } from './logger.js';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

export function listBackgroundBasenames(absDir: string): string[] {
  try {
    if (!fs.existsSync(absDir)) return [];
    return fs
      .readdirSync(absDir, { withFileTypes: true })
      .filter((d) => d.isFile() && IMAGE_EXT.test(d.name) && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch (e) {
    log.warn('[background-picker] list failed', { dir: absDir, err: String(e) });
    return [];
  }
}

function contentTypeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/jpeg';
}

export function registerBackgroundPickerRoutes(app: Express): void {
  app.get('/api/background/random', (_req, res) => {
    const dir = path.resolve(config.backgroundRefDir);
    const names = listBackgroundBasenames(dir);
    if (!names.length) {
      return res.status(404).json({
        error: 'no_background_images',
        hint: `请将 jpg/png/webp 放入 ${dir}，或设置 BACKGROUND_REF_DIR`,
      });
    }
    const name = names[Math.floor(Math.random() * names.length)]!;
    const url = `/api/background/file/${encodeURIComponent(name)}`;
    res.json({ url, name });
  });

  app.get('/api/background/file/:basename', (req, res) => {
    const raw = req.params.basename ?? '';
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return res.status(400).json({ error: 'invalid name' });
    }
    if (!decoded || decoded !== path.basename(decoded) || decoded.includes('..')) {
      return res.status(400).json({ error: 'invalid name' });
    }
    const dir = path.resolve(config.backgroundRefDir);
    const fp = path.resolve(dir, decoded);
    if (!fp.startsWith(dir)) return res.status(400).json({ error: 'invalid path' });
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) return res.status(404).json({ error: 'not found' });
    } catch {
      return res.status(404).json({ error: 'not found' });
    }
    res.setHeader('Content-Type', contentTypeForExt(path.extname(fp)));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(fp);
  });
}

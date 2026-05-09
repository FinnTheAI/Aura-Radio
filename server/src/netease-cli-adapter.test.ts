import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ncma.js', () => ({
  ncmSearch: vi.fn(),
}));

import { ncmSearch } from './ncma.js';
import { extractPlayKeyword, hitsFromCliStdoutJson, searchSongHitsForPlayIntent } from './netease-cli-adapter.js';

describe('netease-cli-adapter', () => {
  beforeEach(() => {
    vi.mocked(ncmSearch).mockResolvedValue([
      { id: '99', name: '晴天', artists: ['Jay'] },
    ]);
  });

  it('extractPlayKeyword strips common play prefixes', () => {
    expect(extractPlayKeyword('播放晴天')).toBe('晴天');
    expect(extractPlayKeyword('播放一下 周杰伦 晴天')).toBe('周杰伦 晴天');
    expect(extractPlayKeyword('点播「稻香」')).toBe('稻香');
    expect(extractPlayKeyword('帮我放 七里香')).toBe('七里香');
    expect(extractPlayKeyword('今天天气好')).toBeNull();
  });

  it('searchSongHitsForPlayIntent delegates to ncmSearch', async () => {
    const hits = await searchSongHitsForPlayIntent('晴天', 3);
    expect(ncmSearch).toHaveBeenCalledWith('晴天', 3);
    expect(hits).toHaveLength(1);
    expect(hits[0].ncmSongId).toBe('99');
  });

  it('hitsFromCliStdoutJson reads nested songs with originalId', () => {
    const j = {
      success: true,
      data: {
        songs: [
          { originalId: 123, name: 'Test', artists: [{ name: 'A' }] },
          { id: 'HEXONLY', name: 'bad' },
        ],
      },
    };
    const hits = hitsFromCliStdoutJson(j);
    expect(hits).toHaveLength(1);
    expect(hits[0].ncmSongId).toBe('123');
    expect(hits[0].name).toBe('Test');
    expect(hits[0].artists).toEqual(['A']);
  });
});

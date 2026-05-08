import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /** 避免与本地 dev 服务争用 data/state.db */
    env: { STATE_DB_PATH: ':memory:' },
  },
});

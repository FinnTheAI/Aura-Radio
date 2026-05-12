import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExpressApp } from './express-app.js';
import { QueueEngine } from './queue-engine.js';
import { StreamHub } from './stream-hub.js';

describe('HTTP contract (ARCH_DOC / CONTRACT.yaml)', () => {
  const stream = new StreamHub();
  const queue = new QueueEngine(stream);
  const app = buildExpressApp(queue, stream);

  beforeAll(async () => {
    queue.start();
  });

  afterAll(async () => {
    queue.stop();
  });

  it('GET /health', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/queue/advance when idle', async () => {
    const res = await request(app).post('/api/queue/advance').send({ traceId: 'any-id' }).expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe('no_active');
  });

  it('POST /api/playback/next-offline rejects when online', async () => {
    const res = await request(app).post('/api/playback/next-offline').expect(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('GET /api/plan/today', async () => {
    const res = await request(app).get('/api/plan/today').set('X-Timezone', 'Asia/Shanghai').expect(200);
    expect(Array.isArray(res.body.blocks)).toBe(true);
    expect(typeof res.body.timezoneNote).toBe('string');
  });

  it('GET /api/taste', async () => {
    const res = await request(app).get('/api/taste').expect(200);
    expect(res.body.taste).toBeTruthy();
    expect(typeof res.body.moodRules).toBe('string');
    expect(typeof res.body.updatedAt).toBe('string');
    expect(res.body.cloud).toBeTruthy();
    expect(typeof res.body.cloud.configured).toBe('boolean');
    expect(Array.isArray(res.body.cloud.artistsTop10)).toBe(true);
  });

  it('GET /api/taste?source=cloud', async () => {
    const res = await request(app).get('/api/taste').query({ source: 'cloud', refresh: 'false' }).expect(200);
    expect(res.body.source).toBe('cloud');
    expect(res.body.cloud).toBeTruthy();
    expect(Array.isArray(res.body.cloud.artistsTop10)).toBe(true);
  });

  it('GET /api/favorites/status', async () => {
    const res = await request(app).get('/api/favorites/status').expect(200);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.downloaded).toBe('number');
    expect(typeof res.body.pending).toBe('number');
    expect(typeof res.body.failed).toBe('number');
    expect(res.body.progressPercent === null || typeof res.body.progressPercent === 'number').toBe(true);
  });

  it(
    'POST /api/chat → traceId + djScript',
    async () => {
      const res = await request(app).post('/api/chat').send({ text: 'hello contract' }).expect(200);

      expect(typeof res.body.traceId).toBe('string');

      expect(res.body.queued).toBe(true);

      expect(res.body.djScript.schemaVersion).toBe(1);

      expect(Array.isArray(res.body.djScript.play)).toBe(true);
    },
    25_000,
  );

  it('GET /api/now + /api/next', async () => {
    await request(app).get('/api/now').expect(200);

    const n = await request(app).get('/api/next').query({ limit: 3 }).expect(200);

    expect(Array.isArray(n.body.items)).toBe(true);

  });

  it('GET /api/audio/proxy validates url param', async () => {
    await request(app).get('/api/audio/proxy').expect(400);
    await request(app).get('/api/audio/proxy').query({ url: 'ftp://bad' }).expect(400);
  });

  it(
    'POST /api/chat with replaceQueue',
    async () => {
      await request(app).post('/api/chat').send({ text: 'seed queue' }).expect(200);
      const res = await request(app)
        .post('/api/chat')
        .send({ text: 'replace me', replaceQueue: true })
        .expect(200);
      expect(res.body.queued).toBe(true);
      expect(typeof res.body.traceId).toBe('string');
    },
    25_000,
  );

  it('POST /api/playback-mode clears queue (then restore online)', async () => {
    await request(app).post('/api/chat').send({ text: 'mode-clear-queue-test', replaceQueue: true }).expect(200);
    let np = await request(app).get('/api/now').expect(200);
    expect(np.body.type).not.toBe('idle');
    await request(app).post('/api/playback-mode').send({ mode: 'offline', confirm: true }).expect(200);
    np = await request(app).get('/api/now').expect(200);
    expect(np.body.type).toBe('idle');
    await request(app).post('/api/playback-mode').send({ mode: 'online', confirm: true }).expect(200);
    np = await request(app).get('/api/now').expect(200);
    expect(np.body.type).toBe('idle');
  }, 25_000);
});


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
  });

  it('POST /api/chat → traceId + djScript', async () => {
    const res = await request(app).post('/api/chat').send({ text: 'hello contract' }).expect(200);

    expect(typeof res.body.traceId).toBe('string');

    expect(res.body.queued).toBe(true);

    expect(res.body.djScript.schemaVersion).toBe(1);

    expect(Array.isArray(res.body.djScript.play)).toBe(true);
  });

  it('GET /api/now + /api/next', async () => {
    await request(app).get('/api/now').expect(200);

    const n = await request(app).get('/api/next').query({ limit: 3 }).expect(200);

    expect(Array.isArray(n.body.items)).toBe(true);

  });

  it('GET /api/audio/proxy validates url param', async () => {
    await request(app).get('/api/audio/proxy').expect(400);
    await request(app).get('/api/audio/proxy').query({ url: 'ftp://bad' }).expect(400);
  });

  it('POST /api/chat with replaceQueue', async () => {
    await request(app).post('/api/chat').send({ text: 'seed queue' }).expect(200);
    const res = await request(app)
      .post('/api/chat')
      .send({ text: 'replace me', replaceQueue: true })
      .expect(200);
    expect(res.body.queued).toBe(true);
    expect(typeof res.body.traceId).toBe('string');
  });
});


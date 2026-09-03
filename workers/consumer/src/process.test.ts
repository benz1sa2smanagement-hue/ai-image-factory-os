import { describe, it, expect } from 'vitest';
import { processMessage, type Env } from './index.js';

const env: Env = { MOCK_MODE: 'true' };

describe('queue consumer processMessage', () => {
  it('blocks generation when factory stopped (no DB → STOPPED)', async () => {
    const r = await processMessage(env, {
      jobId: 'j1',
      type: 'IMAGE_GENERATION',
      payload: { prompt: 'test' },
    });
    expect(r.code).toBe('FACTORY_STOPPED');
  });

  it('QC passes healthy payload', async () => {
    const r = await processMessage(env, {
      jobId: 'j2',
      type: 'QC',
      payload: {
        exists: true,
        byteSize: 40_000,
        width: 1024,
        height: 1024,
        mimeType: 'image/jpeg',
        sha256: 'b'.repeat(64),
      },
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe('QC_PASSED');
  });

  it('QC rejects tiny image', async () => {
    const r = await processMessage(env, {
      jobId: 'j3',
      type: 'QC',
      payload: { exists: true, byteSize: 10, width: 32, height: 32 },
    });
    expect(r.code).toBe('QC_REJECTED');
  });

  it('duplicate exact', async () => {
    const r = await processMessage(env, {
      jobId: 'j4',
      type: 'DUPLICATE_CHECK',
      payload: {
        sha256: 'abc',
        existing: [{ hashType: 'sha256', hashValue: 'abc', assetId: 'old' }],
      },
    });
    expect(r.code).toBe('DUPLICATE_REJECTED');
  });

  it('duplicate clear', async () => {
    const r = await processMessage(env, {
      jobId: 'j5',
      type: 'DUPLICATE_CHECK',
      payload: { sha256: 'unique', existing: [] },
    });
    expect(r.code).toBe('DUPLICATE_CLEAR');
  });

  it('metadata → READY_TO_UPLOAD manual', async () => {
    const r = await processMessage(env, { jobId: 'j6', type: 'METADATA' });
    expect(r.code).toBe('READY_TO_UPLOAD');
    expect(r.detail).toContain('manual');
  });

  it('cleanup skips uploaded', async () => {
    const r = await processMessage(env, {
      jobId: 'j7',
      type: 'CLEANUP',
      payload: { uploaded: true, status: 'REJECTED', r2Key: 'x', createdAt: '2020-01-01' },
    });
    expect(r.code).toBe('CLEANUP_SKIP');
  });

  it('watchdog runs', async () => {
    const r = await processMessage(env, { jobId: 'j8', type: 'WATCHDOG' });
    expect(r.code).toBe('WATCHDOG_OK');
  });

  it('mock generation when assume running', async () => {
    const r = await processMessage(env, {
      jobId: 'j9',
      type: 'IMAGE_GENERATION',
      payload: { prompt: 'kraft packaging', mockAssumeRunning: true, width: 512, height: 512, steps: 4 },
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe('MOCK_GENERATED');
  });
});

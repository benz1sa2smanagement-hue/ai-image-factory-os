import { describe, expect, it, vi } from 'vitest';
import { CF_FLUX_SCHNELL, generateWithWorkersAi } from './cloudflare-flux.js';

describe('Cloudflare FLUX adapter', () => {
  it('passes prompt, dimensions, steps and seed to Workers AI', async () => {
    const run = vi.fn().mockResolvedValue({ image: 'base64-jpeg' });
    const ai = { run };

    const result = await generateWithWorkersAi(ai, 'product photo', {
      width: 1024,
      height: 768,
      steps: 8,
      seed: 123,
    });

    expect(run).toHaveBeenCalledWith(CF_FLUX_SCHNELL, {
      prompt: 'product photo',
      width: 1024,
      height: 768,
      steps: 8,
      seed: 123,
    });
    expect(result).toEqual({ base64: 'base64-jpeg' });
  });

  it('caps steps at the FLUX maximum', async () => {
    const run = vi.fn().mockResolvedValue({ image: 'x' });

    await generateWithWorkersAi({ run }, 'test', { steps: 99 });

    expect(run.mock.calls[0]?.[1]).toMatchObject({ steps: 8 });
  });

  it('keeps non-image responses as raw output instead of pretending they are images', async () => {
    const raw = new ArrayBuffer(2);
    const run = vi.fn().mockResolvedValue(raw);

    const result = await generateWithWorkersAi({ run }, 'test');

    expect(result.base64).toBeUndefined();
    expect(result.raw).toBe(raw);
  });
});

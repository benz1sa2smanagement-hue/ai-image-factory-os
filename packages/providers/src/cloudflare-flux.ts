/**
 * Cloudflare Workers AI adapter for FLUX.1 Schnell.
 * Only invoke when zero-cost policy + quota reserve succeed.
 * Binding usage (preferred in Workers):
 *   env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt, steps, seed })
 */

export const CF_FLUX_SCHNELL = '@cf/black-forest-labs/flux-1-schnell' as const;

export interface CfAiRun {
  run(model: string, input: Record<string, unknown>): Promise<{ image?: string } | ArrayBuffer | ReadableStream>;
}

export async function generateWithWorkersAi(
  ai: CfAiRun,
  prompt: string,
  opts?: { steps?: number; seed?: number }
): Promise<{ base64?: string; raw?: unknown }> {
  const steps = Math.min(opts?.steps ?? 4, 8);
  const result = await ai.run(CF_FLUX_SCHNELL, {
    prompt,
    steps,
    seed: opts?.seed ?? Math.floor(Math.random() * 1_000_000),
  });
  if (result && typeof result === 'object' && 'image' in result && typeof (result as { image: string }).image === 'string') {
    return { base64: (result as { image: string }).image };
  }
  return { raw: result };
}

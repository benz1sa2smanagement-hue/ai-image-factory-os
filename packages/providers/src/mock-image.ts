import type { ImageGenerationProvider, ImageGenerationRequest, ImageGenerationResult } from '../../domain/src/providers.js';

/** Deterministic mock — no network, no quota */
export class MockImageProvider implements ImageGenerationProvider {
  readonly id = 'mock';
  readonly modelId = 'mock-image-v1';

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const w = req.width ?? 512;
    const h = req.height ?? 512;
    // Minimal valid JPEG SOI/EOI stub for pipeline testing
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    return {
      imageBytes: bytes,
      mimeType: 'image/jpeg',
      providerId: this.id,
      modelId: this.modelId,
      meta: { prompt: req.prompt, width: w, height: h, mock: true },
    };
  }
}

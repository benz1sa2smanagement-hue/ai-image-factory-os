/**
 * ProviderRegistry — resolve GenerationProvider implementations by stable id.
 *
 * Does NOT select providers (Router does).
 * Does NOT reserve/commit/release quota.
 * Does NOT retry or fall back to another provider.
 * Does NOT hold credentials or call network.
 */

import type { GenerationProvider } from './generation.js';

export type RegistryResolveResult =
  | { ok: true; provider: GenerationProvider }
  | { ok: false; code: 'PROVIDER_NOT_REGISTERED'; providerId: string };

export type RegistryRegisterResult =
  | { ok: true }
  | { ok: false; code: 'DUPLICATE_PROVIDER_ID'; providerId: string };

export class ProviderRegistry {
  private readonly adapters = new Map<string, GenerationProvider>();

  register(provider: GenerationProvider): RegistryRegisterResult {
    if (this.adapters.has(provider.id)) {
      return { ok: false, code: 'DUPLICATE_PROVIDER_ID', providerId: provider.id };
    }
    this.adapters.set(provider.id, provider);
    return { ok: true };
  }

  /** Overwrite existing id (explicit replace — not silent) */
  replace(provider: GenerationProvider): void {
    this.adapters.set(provider.id, provider);
  }

  resolve(providerId: string): RegistryResolveResult {
    const provider = this.adapters.get(providerId);
    if (!provider) {
      return { ok: false, code: 'PROVIDER_NOT_REGISTERED', providerId };
    }
    return { ok: true, provider };
  }

  has(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  list(): GenerationProvider[] {
    return Array.from(this.adapters.values()).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
  }

  ids(): string[] {
    return this.list().map((p) => p.id);
  }

  size(): number {
    return this.adapters.size;
  }
}

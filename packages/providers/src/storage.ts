/** Storage provider abstraction. Domain logic must not depend on a specific cloud storage vendor. */

export interface StoredObject {
  key: string;
  mimeType: string;
  byteSize: number;
}

export interface StorageProvider {
  put(input: { key: string; data: ArrayBuffer | Uint8Array; mimeType: string }): Promise<StoredObject>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class MockStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, { data: Uint8Array; mimeType: string }>();

  async put(input: { key: string; data: ArrayBuffer | Uint8Array; mimeType: string }): Promise<StoredObject> {
    const data = input.data instanceof Uint8Array ? input.data.slice() : new Uint8Array(input.data);
    this.objects.set(input.key, { data, mimeType: input.mimeType });
    return { key: input.key, mimeType: input.mimeType, byteSize: data.byteLength };
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return object.data.slice().buffer;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

import type { StorageProvider, StoredObject } from './storage.js';

export interface GoogleDriveStorageConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId: string;
  maxFileBytes?: number;
}

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DEFAULT_MAX_FILE_BYTES = 15 * 1024 * 1024;
const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;

export class GoogleDriveStorageProvider implements StorageProvider {
  constructor(private readonly config: GoogleDriveStorageConfig) {}

  private async accessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error(`GOOGLE_TOKEN_REFRESH_FAILED:${response.status}`);
    const json = (await response.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('GOOGLE_TOKEN_REFRESH_MISSING_ACCESS_TOKEN');
    return json.access_token;
  }

  private async request(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(input, { ...init, headers });
    if (!response.ok) {
      throw new Error(`GOOGLE_DRIVE_REQUEST_FAILED:${response.status}`);
    }
    return response;
  }

  async put(input: { key: string; data: ArrayBuffer | Uint8Array; mimeType: string }): Promise<StoredObject> {
    const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
    const max = this.config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (bytes.byteLength > max) throw new Error('GOOGLE_DRIVE_FILE_TOO_LARGE');

    const metadata = {
      name: input.key,
      parents: [this.config.folderId],
      description: `AI Image Factory storage key: ${input.key}`,
    };

    if (bytes.byteLength > MULTIPART_MAX_BYTES) {
      const initResponse = await this.request(
        `${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,name,mimeType,size`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'x-upload-content-type': input.mimeType,
            'x-upload-content-length': String(bytes.byteLength),
          },
          body: JSON.stringify(metadata),
        }
      );
      const session = initResponse.headers.get('location');
      if (!session) throw new Error('GOOGLE_DRIVE_RESUMABLE_SESSION_MISSING');
      const token = await this.accessToken();
      const uploadResponse = await fetch(session, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': input.mimeType,
          'content-length': String(bytes.byteLength),
        },
        body: bytes,
      });
      if (!uploadResponse.ok) throw new Error(`GOOGLE_DRIVE_UPLOAD_FAILED:${uploadResponse.status}`);
      const file = (await uploadResponse.json()) as DriveFile;
      return { key: input.key, mimeType: file.mimeType ?? input.mimeType, byteSize: Number(file.size ?? bytes.byteLength) };
    }
    const boundary = `aif-${crypto.randomUUID()}`;
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      `--${boundary}\\r\\nContent-Type: application/json; charset=UTF-8\\r\\n\\r\\n${JSON.stringify(metadata)}\\r\\n--${boundary}\\r\\nContent-Type: ${input.mimeType}\\r\\n\\r\\n`
    );
    const suffix = encoder.encode(`\\r\\n--${boundary}--\\r\\n`);
    const body = new Uint8Array(prefix.byteLength + bytes.byteLength + suffix.byteLength);
    body.set(prefix, 0);
    body.set(bytes, prefix.byteLength);
    body.set(suffix, prefix.byteLength + bytes.byteLength);

    const response = await this.request(
      `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,mimeType,size`,
      {
        method: 'POST',
        headers: {
          'content-type': `multipart/related; boundary=${boundary}`,
          'content-length': String(body.byteLength),
        },
        body,
      }
    );
    const file = (await response.json()) as DriveFile;
    return { key: input.key, mimeType: file.mimeType ?? input.mimeType, byteSize: Number(file.size ?? bytes.byteLength) };
  }

  private async find(key: string): Promise<DriveFile | null> {
    const escaped = key.replace(/'/g, "\\\\'");
    const query = encodeURIComponent(`name = '${escaped}' and '${this.config.folderId}' in parents and trashed = false`);
    const response = await this.request(`${DRIVE_FILES_URL}?q=${query}&pageSize=10&fields=files(id,name,mimeType,size)`);
    const json = (await response.json()) as { files?: DriveFile[] };
    return json.files?.[0] ?? null;
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const file = await this.find(key);
    if (!file) return null;
    const response = await this.request(`${DRIVE_FILES_URL}/${encodeURIComponent(file.id)}?alt=media`);
    return response.arrayBuffer();
  }

  async exists(key: string): Promise<boolean> {
    return (await this.find(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    const file = await this.find(key);
    if (!file) return;
    await this.request(`${DRIVE_FILES_URL}/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
  }
}

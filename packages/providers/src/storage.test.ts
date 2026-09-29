import { describe, expect, it, vi } from 'vitest';
import { MockStorageProvider } from './storage.js';
import { GoogleDriveStorageProvider } from './google-drive.js';

describe('MockStorageProvider', () => {
  it('round-trips bytes', async () => {
    const storage = new MockStorageProvider();
    await storage.put({ key: 'assets/a.jpg', data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' });
    expect(await storage.exists('assets/a.jpg')).toBe(true);
    expect(Array.from(new Uint8Array((await storage.get('assets/a.jpg'))!))).toEqual([1, 2, 3]);
    await storage.delete('assets/a.jpg');
    expect(await storage.exists('assets/a.jpg')).toBe(false);
  });
});

describe('GoogleDriveStorageProvider', () => {
  it('refreshes the token and uploads through Drive multipart API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'file-1', name: 'a.jpg', mimeType: 'image/jpeg', size: '3' }), { status: 200 }));

    const storage = new GoogleDriveStorageProvider({
      clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', folderId: 'folder', maxFileBytes: 10,
    });
    const result = await storage.put({ key: 'assets/a.jpg', data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' });
    expect(result).toEqual({ key: 'assets/a.jpg', mimeType: 'image/jpeg', byteSize: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('uploadType=multipart');
    fetchMock.mockRestore();
  });


  it('uses resumable upload for assets above 5 MiB', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { location: 'https://upload.example/session' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'file-large', name: 'large.jpg', mimeType: 'image/jpeg', size: String(5 * 1024 * 1024 + 1) }), { status: 200 }));
    const storage = new GoogleDriveStorageProvider({
      clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', folderId: 'folder', maxFileBytes: 6 * 1024 * 1024,
    });
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    const result = await storage.put({ key: 'assets/large.jpg', data: bytes, mimeType: 'image/jpeg' });
    expect(result.byteSize).toBe(5 * 1024 * 1024 + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('uploadType=resumable');
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://upload.example/session');
    fetchMock.mockRestore();
  });

  it('rejects files over the configured hard limit before any network call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const storage = new GoogleDriveStorageProvider({
      clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', folderId: 'folder', maxFileBytes: 2,
    });
    await expect(storage.put({ key: 'assets/a.jpg', data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }))
      .rejects.toThrow('GOOGLE_DRIVE_FILE_TOO_LARGE');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

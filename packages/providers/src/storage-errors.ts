/**
 * Provider-neutral storage error codes.
 * Adapters map vendor failures into these codes.
 * Job-level retry / DLQ remains outside the storage adapter.
 */

export const STORAGE_ERROR_CODES = [
  'STORAGE_NOT_FOUND',
  'STORAGE_TIMEOUT',
  'STORAGE_UNAVAILABLE',
  'STORAGE_PERMISSION_DENIED',
  'STORAGE_INVALID_REQUEST',
  'STORAGE_UNKNOWN',
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly cause?: unknown;

  constructor(code: StorageErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.cause = cause;
  }
}

export function isStorageError(e: unknown): e is StorageError {
  return e instanceof StorageError;
}

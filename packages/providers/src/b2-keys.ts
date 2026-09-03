/**
 * B2 / storage object key convention (provider-agnostic path shape).
 * assets/{asset_id}/original.{ext}
 */

const SAFE_ASSET_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_EXT = /^[a-z0-9]{1,8}$/;

export function buildAssetOriginalKey(assetId: string, ext: string): string {
  if (!SAFE_ASSET_ID.test(assetId)) {
    throw new Error(`invalid assetId for storage key: ${assetId}`);
  }
  const normalizedExt = ext.replace(/^\./, '').toLowerCase();
  if (!SAFE_EXT.test(normalizedExt)) {
    throw new Error(`invalid extension for storage key: ${ext}`);
  }
  return `assets/${assetId}/original.${normalizedExt}`;
}

export function parseAssetOriginalKey(
  key: string
): { assetId: string; ext: string } | null {
  const m = /^assets\/([a-zA-Z0-9_-]{1,128})\/original\.([a-z0-9]{1,8})$/.exec(key);
  if (!m) return null;
  return { assetId: m[1]!, ext: m[2]! };
}

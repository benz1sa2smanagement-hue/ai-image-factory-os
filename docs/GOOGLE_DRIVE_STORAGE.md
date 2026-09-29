# Google Drive storage setup

Google Drive is the new primary storage target. Backblaze B2 is retained only as legacy/diagnostic code and is not on the critical path.

## Runtime secrets

Set these as Cloudflare Worker secrets; never commit them:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_DRIVE_FOLDER_ID`

Optional non-secret variable:

- `GOOGLE_DRIVE_MAX_FILE_BYTES` (default: 15728640 / 15 MiB)

The adapter uses a long-lived OAuth refresh token to obtain short-lived access tokens. Google documents that refresh tokens are required for long-term private Drive API access and should be stored securely. citeturn0search11

## Zero-cost guard

The application must not enable a paid storage fallback. Google documents standard Drive API use as no-additional-cost, while quota changes introduced in 2026 include a later billing model for usage above the standard daily threshold. The project therefore treats the standard quota as a hard ceiling and does not implement quota-increase/billing fallback. citeturn0search0turn0search6

## Current implementation

- `packages/providers/src/storage.ts`: vendor-neutral storage contract + deterministic mock.
- `packages/providers/src/google-drive.ts`: native `fetch()` implementation for OAuth refresh, multipart upload, download, existence check, and delete.
- `packages/providers/src/storage.test.ts`: offline tests for round-trip storage, token/upload flow, and hard file-size limit.

No Google credentials are stored in the repository.

## Remaining owner setup

1. Enable Google Drive API in a Google Cloud project.
2. Create OAuth credentials and authorize the Drive account once.
3. Put the resulting refresh token and client credentials into Cloudflare Worker Secrets.
4. Create/select a Drive folder and set its ID as `GOOGLE_DRIVE_FOLDER_ID`.
5. Run the live storage smoke test before enabling non-mock generation.

This project deliberately does not request a quota increase or add a paid Google Cloud dependency.

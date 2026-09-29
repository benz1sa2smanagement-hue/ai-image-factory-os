# Ephemeral Asset Flow

## Decision
The project no longer uses Google Drive, Backblaze B2, Cloudflare R2, or another persistent object store for generated images.

Image binaries exist only while actively being processed or delivered to the user.

## Target lifecycle
1. GENERATING — Workers AI produces image bytes.
2. GENERATED — bytes remain in active request/job memory only.
3. QC — checks run on the bytes.
4. DUPLICATE_CHECK — SHA-256/pHash checks use the bytes without persisting the binary.
5. METADATA — D1 stores text/metadata only.
6. READY_TO_UPLOAD — the client receives the selected image for manual marketplace upload.
7. USER UPLOAD — user uploads through the marketplace contributor portal.
8. RELEASE — transient image bytes are discarded after the user no longer needs them.

## Storage rules
- No image binaries in D1, R2, Google Drive, or B2.
- No paid storage fallback.
- Hashes, dimensions, MIME type, job state, metadata, and audit information may be persisted in D1.
- The system must not claim marketplace upload was automatically verified because V1 marketplace upload is manual.

## Failure safety
Do not discard the last available image copy until the client has received it successfully.

## Implementation boundary
The existing domain lifecycle, QC, duplicate detection, D1 state model, and Workers AI provider abstraction remain reusable. The next implementation step is to make the live API return an image payload after generation/QC while keeping image bytes out of D1/R2/Drive/B2.

Until that live path is implemented and tested, MOCK_MODE remains the safe default.
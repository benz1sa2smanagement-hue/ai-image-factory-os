# Setup — card-free pilot (safe mode)

Goal: try AI Image Factory OS without adding a payment card or enabling any paid service.

## Current scope
- This is **not** a ready-to-run fully automated stock-selling product.
- Dashboard and marketplace upload are not implemented. Marketplace submission stays manual.
- Never provision R2, Backblaze B2, a paid Workers plan, or any service requiring billing details for this pilot.
- Image bytes are ephemeral. Download generated files immediately; no cloud storage or automatic recovery is guaranteed.
- A Worker deployment and live Workers AI availability must be tested on the owner's actual free account before describing the system as operational.

## Preflight (no billing changes)
1. Confirm the Cloudflare account can access **D1, Workers and the specific Workers AI image model** on its free plan without a card. If any step asks for billing information, **STOP**. Do not proceed or attach a card.
2. Verify the model's current free quota and commercial-use terms from official documentation. Free access and no-card availability are account-dependent.
3. Keep the factory **STOPPED** by default and `MOCK_MODE=true` until bindings, migrations and free-only guards are verified.
4. Configure `AIF_ADMIN_TOKEN` as a Worker secret (never commit it). `/factory/resume`, `/factory/stop`, and `/v1/generate` require an `Authorization: Bearer <token>` header.
5. Provision D1 only if the account has card-free access, run migrations, configure D1 and Workers AI bindings, and confirm `/health` and `/factory/status`.
6. Test one mock request, then **at most one** live generation once free quota and account entitlement are confirmed. Verify the result can be downloaded and no billable operation was enabled.
7. Only after a successful test, resume the factory and generate images manually in small batches. Stop if free quota, entitlement, billing, or image delivery is uncertain.

## Safety and limitations
- Generation requests are authenticated; never put the admin token in a public static site's JavaScript.
- The no-paid-API policy applies to application calls, but cannot substitute for provider/account-level spending safeguards; never enable a paid account for the 0-baht pilot.
- Stock marketplaces have content, disclosure, resolution and submission requirements. QC pass is not proof that an image is accepted or earns money.
- No unattended live production, automatic marketplace publishing, or background asset retention is promised in this stage.

## Local development
```bash
npm install
npm run test
npm run typecheck
MOCK_MODE=true npm run dev
```

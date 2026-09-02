# Quota Manager

## Flow

```
CHECK → RESERVE → EXECUTE → COMMIT
                 ↘ on failure → RELEASE
```

Reservations are rows in `quota_reservations` with TTL to prevent leaks.

Tracks (configurable per provider, **not hard-coded forever**):

- daily / monthly neurons or units
- per-minute rate
- per-model
- per-provider

Race safety: reserve in a D1 transaction; other workers cannot consume the same reservation.

If free quota exhausted → provider disabled for window → fallback free provider → else `WAITING_FOR_QUOTA`.

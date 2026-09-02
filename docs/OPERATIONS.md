# Operations

## STOP / RESUME

Dashboard buttons set `settings.factory_status`.

## Watchdog (cron)

Checks queue depth, failed jobs, quota remaining, R2 usage signals, provider health.

## Cleanup

Deletes R2 objects only when:

- uploaded = true OR retention expired
- AND no pending job
- AND keep ≠ true

# Security

- Secrets only in Cloudflare Secrets / env — never in git
- No marketplace passwords in Factory if not required
- AuthN/AuthZ on dashboard API (to be implemented)
- Audit log for privileged actions and state transitions
- Input validation on all worker entrypoints
- Rate limiting at edge
- CSRF protection for cookie sessions when added

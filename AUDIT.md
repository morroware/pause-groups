# Pause Group Automation Audit (Reliability + Security)

Date: 2026-02-25
Scope reviewed: API routes, auth/session handling, scheduler/cron flow, installer behavior, crypto/storage patterns, and operational docs present in repository.

## Executive Summary

Overall, the project has a solid baseline for a small internal operations tool:
- Parameterized SQL usage throughout the codebase.
- Session auth + CSRF enforcement for state-changing API operations.
- CLI-only guards on job runner scripts.
- Locking in cron/runner to reduce concurrency races.

The highest-impact issue identified was an installer hardening gap that could allow **unauthenticated creation of additional admin users** if `install.php` remained web-accessible after first setup. This is fixed in this branch.

## What Was Fixed

### 1) Installer post-setup lockout (Critical)

**Issue:** In web mode, `install.php` allowed `POST step=create_admin` processing even after setup had been completed, as long as a new username was supplied.

**Impact:** If `install.php` was left reachable (common in rushed deployments), an attacker could create an admin account without authentication.

**Fix:** Added an early guard in POST handling to block all installer actions once any admin exists.

## Remaining Findings (Prioritized)

### High Priority

1. **Credential encryption uses AES-CBC without an integrity tag (MAC/AEAD).**
   - Current encryption in `lib/crypto.php` is confidentiality-only.
   - Recommendation: migrate to AEAD (e.g., `aes-256-gcm` or libsodium sealed boxes) with versioned payloads for backward compatibility.

2. **No explicit brute-force throttling strategy for login endpoint beyond fixed sleep(1).**
   - Recommendation: add IP+username rate limiting (e.g., sliding window in SQLite) and optional temporary lockouts after repeated failures.

3. **No enforced deployment guardrails for install endpoint.**
   - While fixed for account creation after setup, best practice is still to remove or deny web access to `install.php` via web server config after install.

### Medium Priority

1. **Missing stronger HTTP response header posture.**
   - Consider adding a CSP, `Permissions-Policy`, and (if always HTTPS) HSTS at web server layer.

2. **Authentication/session hardening opportunities.**
   - Consider setting `session.use_only_cookies=1` and a strict cookie secure policy in production (HTTPS-only deployments).

3. **Operational dependencies not preflighted by installer.**
   - Scheduler relies on `at`/`atrm`; installer could verify presence and clearly report if missing.

### Low Priority

1. **No automated test suite currently in repo.**
   - Add smoke/integration checks for auth, schedule planning, and override conflict resolution.

2. **Runbook docs are minimal.**
   - Add docs for backup/restore, key rotation, disaster recovery, and "known failure modes + recovery steps".

## Reliability Notes

- The lock-file approach in `cron.php` and `run_action.php` is good and prevents duplicate runners.
- Replan-on-change behavior in schedules/overrides improves operational correctness.
- Database busy timeout and WAL mode are sensible for lightweight concurrent access.

## Recommended Next Actions (Practical, Not Over-Engineered)

1. **Deployment hardening now (same day):**
   - Block web access to `install.php` in Nginx/Apache.
   - Ensure HTTPS termination and secure cookie usage.
   - Verify filesystem permissions (`data/` writable only by app user).

2. **Security uplift (short sprint):**
   - Add login rate limiter.
   - Migrate credential encryption to AEAD with backward-compatible decrypt path.

3. **Reliability uplift (short sprint):**
   - Add a small test harness for key API and scheduler paths.
   - Add runbook docs for backup/restore and incident response.

## Suggested Production Checklist

- [ ] `install.php` blocked or removed after install.
- [ ] `PG_ENCRYPTION_KEY` set and rotated through secure process.
- [ ] HTTPS enforced end-to-end.
- [ ] `data/` permissions verified least-privilege.
- [ ] Cron configured + log file monitored.
- [ ] Alerting added for repeated API failures and action execution errors.
- [ ] Backup/restore tested on a non-production copy.


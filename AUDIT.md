# Reliability & Security Audit

Date: 2026-02-25
Scope: Full repository review (`api/`, `lib/`, entrypoints, and implementation docs).

## Executive Summary

The project is structurally solid for a lightweight, dependency-free PHP app: input validation is broadly consistent, SQL access uses prepared statements, authentication has session fixation protection, and CSRF protection is present for state-changing requests.

Two **high-priority hardening gaps** were found and fixed in this audit:

1. Static file path traversal risk in `index.php` static asset serving.
2. Internal exception message leakage in API 500 responses.

Additional medium/low-priority reliability and operational recommendations are listed below.

---

## What Was Reviewed

- Request routing, API dispatch, and static file serving (`index.php`)
- Authentication/session/CSRF (`lib/auth.php`, `lib/csrf.php`, `api/auth.php`)
- Data access and schema (`lib/db.php`)
- Crypto and secrets handling (`lib/crypto.php`, `api/settings.php`, `config.php`)
- Scheduler and execution model (`lib/scheduler.php`, `cron.php`, `run_action.php`)
- External API integration (`lib/centeredge_client.php`)
- Validation and user input handling (`lib/validator.php`)
- Front-end data rendering patterns (`public/js/*.js`)
- Existing documentation (`IMPLEMENTATION-PLAN.md`)

---

## Findings

## ✅ Fixed During This Audit

### 1) Static file traversal hardening
- **Risk:** The prior static route accepted any path starting with `public/` and then directly checked `file_exists/is_file`, which could allow traversal strings like `public/../...`.
- **Fix:** Enforced `realpath()` root check so files are served only if they resolve under the canonical `public/` directory.
- **Impact:** Prevents accidental source/config exposure through crafted URLs.

### 2) Internal exception leakage reduced
- **Risk:** API 500 responses returned raw exception text in normal operation.
- **Fix:** Added `APP_DEBUG` config flag. In non-debug mode, API now returns generic `Internal server error` (while still logging full errors server-side).
- **Impact:** Reduces information disclosure to unauthenticated/low-trust callers.

### 3) Baseline response hardening headers
- Added defensive headers from the PHP entrypoint:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`

---

## ⚠️ Open Recommendations (Not Blocking MVP)

### A) Add request-level login throttling
- Current brute-force delay is `sleep(1)` on failed auth, which helps but is weak under distributed attacks.
- Recommended: store failed attempts per username/IP and apply temporary lockouts/backoff windows.

### B) Add authenticated encryption for config secrets
- Current encryption uses AES-CBC without a separate authenticity tag (integrity).
- Recommended: migrate to AES-256-GCM (or libsodium secretbox) for new writes while keeping backward decrypt compatibility for existing ciphertexts.

### C) Operational dependency checks for `at`/`atd`
- Scheduler assumes `at` is present and daemon running.
- Recommended: add explicit health check in install/cron paths with a clear action item if unavailable.

### D) Add deployment runbook doc
- Existing implementation plan is detailed but design-oriented.
- Recommended: short `DEPLOYMENT.md` with:
  - required packages/services
  - permission model
  - cron + atd setup/verification
  - backup/restore for SQLite database
  - upgrade process and rollback steps

### E) Improve config validation guardrails
- For `base_url`, optionally enforce `https://` in production mode and reject non-TLS URLs unless an explicit override flag is set.

---

## Quick Reliability Checklist (Production)

- [ ] `PG_ENCRYPTION_KEY` set to 64+ hex chars and backed up securely.
- [ ] `data/` directory owned by runtime user and not web-browsable.
- [ ] `cron.php` scheduled daily and writing logs.
- [ ] `atd` running; `atq`/`at` commands operational.
- [ ] TLS terminated properly at web server/proxy.
- [ ] `PG_APP_DEBUG` disabled in production.
- [ ] Regular backup of `data/pause_groups.db` (+ WAL/SHM awareness).


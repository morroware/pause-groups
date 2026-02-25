# Reliability & Security Audit

Date: 2026-02-25
Scope: Full repository review (`api/`, `lib/`, `public/js/`, entrypoints, installer, and documentation).

## Executive Summary

The project is structurally solid for a lightweight, dependency-free PHP application. Input validation is broadly consistent, SQL access uses prepared statements, authentication has session fixation protection, and CSRF protection is present for all state-changing requests.

Two rounds of review have been performed:

1. **Initial audit** found and fixed path traversal risk, exception leakage, and missing response headers.
2. **Second audit** found and fixed eight functional bugs across the frontend-backend integration boundary that would have prevented core features from working correctly.

All identified issues have been resolved. The application is functional for PoC/MVP demonstration.

---

## What Was Reviewed

- Request routing, API dispatch, and static file serving (`index.php`)
- Authentication/session/CSRF (`lib/auth.php`, `lib/csrf.php`, `api/auth.php`)
- Data access and schema (`lib/db.php`)
- Crypto and secrets handling (`lib/crypto.php`, `api/settings.php`, `config.php`)
- Scheduler and execution model (`lib/scheduler.php`, `cron.php`, `run_action.php`)
- External API integration (`lib/centeredge_client.php`)
- Validation and user input handling (`lib/validator.php`)
- All API endpoint handlers (`api/*.php`)
- All frontend modules (`public/js/*.js`)
- Installer script (`install.php`)
- Documentation (`IMPLEMENTATION-PLAN.md`)

---

## Findings Fixed (Round 1 -- Security Hardening)

### 1. Static file traversal hardening
- **Risk:** The static route accepted any path starting with `public/` and checked `file_exists`/`is_file`, allowing traversal strings like `public/../config.php`.
- **Fix:** Enforced `realpath()` root check so files are served only if they resolve under the canonical `public/` directory.

### 2. Internal exception leakage
- **Risk:** API 500 responses returned raw exception text to the client.
- **Fix:** Added `APP_DEBUG` config flag. In non-debug mode, the API returns a generic `Internal server error` message while logging full errors server-side.

### 3. Baseline response hardening headers
- Added defensive headers from the PHP entrypoint:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`

---

## Findings Fixed (Round 2 -- Functional Bugs)

### 4. install.php config key mismatch and double encryption
- **Bug:** The installer saved API credentials with keys `api_username` and `api_password`, but the CenterEdge client reads `username` and `password`. Additionally, the installer manually called `Crypto::encrypt()` before passing the value to `DB::setConfig()` without setting the `encrypted` flag, causing double encryption on read and corrupted credential retrieval.
- **Fix:** Changed installer to use correct key names (`username`, `password`) and pass plaintext values with the `encrypt=true` flag to `DB::setConfig()`, matching the pattern used by the settings API.
- **File:** `install.php`

### 5. Settings frontend-backend field name mismatch
- **Bug:** The settings frontend sent `api_username` / `api_password` in PUT requests but the backend expected `username` / `password`. The GET response returned `username` / `password` but the frontend read `data.api_username` / `data.api_password`, causing form fields to always appear empty.
- **Fix:** Aligned the frontend to use `username` and `password` for both reading and writing.
- **File:** `public/js/settings.js`

### 6. Timezone save broken by required API fields
- **Bug:** The settings PUT handler required `base_url` and `username` via `Validator::requireUrl()` and `Validator::requireString()`, which threw exceptions when saving timezone-only updates (the timezone form only sends `{ timezone: "..." }`).
- **Fix:** Made the PUT handler detect whether API config fields or timezone are being updated and validate accordingly, supporting partial updates.
- **File:** `api/settings.php`

### 7. Log viewer filter parameter name mismatch
- **Bug:** The frontend sent `date_from` / `date_to` query parameters but the backend read `from` / `to` from `$_GET`, causing date-range filtering to silently fail.
- **Fix:** Changed the frontend to send `from` / `to` to match the backend.
- **File:** `public/js/logs.js`

### 8. Log viewer timestamp field name mismatch
- **Bug:** The frontend displayed `log.created_at` for the timestamp column, but the `action_log` table uses a column named `timestamp`, not `created_at`. Log entries showed blank timestamps.
- **Fix:** Changed to `log.timestamp`.
- **File:** `public/js/logs.js`

### 9. Log viewer filter options mismatched backend validation
- **Bug:** The source filter dropdown offered `api` and `system` which are not valid source values in the backend. The action filter offered `sync`, `login`, and `logout` which are not in the backend's allowed action list. Selecting these would produce empty results.
- **Fix:** Aligned dropdown options to match backend validation: sources are `cron`, `manual`, `override`, `schedule`; actions are `pause`, `unpause`, `skip`, `plan_day`, `execute_action`.
- **File:** `public/js/logs.js`

### 10. User toggle active/inactive broken by required display_name
- **Bug:** The user activate/deactivate toggle sent only `{ is_active: true/false }`, but the PUT handler called `Validator::requireString($input, 'display_name')` which threw because `display_name` was not included in the request body.
- **Fix:** Changed to `Validator::optionalString()` with fallback to the existing `display_name` value from the database.
- **File:** `api/users.php`

### 11. Test Connection result display
- **Bug:** The test connection UI displayed `result.message` which does not exist in the `testConnection()` response. The success state showed "Connected." with no useful detail.
- **Fix:** Display `system_name`, `game_count`, `category_count`, and `supports_operation_status` from the actual response object.
- **File:** `public/js/settings.js`

---

## Open Recommendations (Not Blocking MVP)

### A. Add request-level login throttling
- Current brute-force delay is `sleep(1)` on failed auth, which limits single-source attacks but is weak under distributed attempts.
- Recommended: store failed attempts per username/IP in the database and apply temporary lockouts or exponential backoff windows.

### B. Add authenticated encryption for config secrets
- Current encryption uses AES-256-CBC without a separate authenticity tag. This provides confidentiality but not integrity verification.
- Recommended: migrate to AES-256-GCM (or libsodium `crypto_secretbox`) for new writes while keeping backward decrypt compatibility for existing ciphertexts.

### C. Operational dependency checks for `at`/`atd`
- The scheduler assumes the `at` command is present and the `atd` daemon is running.
- Recommended: add an explicit health check in the install and cron paths with a clear error message if `at` is unavailable.

### D. Enforce HTTPS for API base URL in production
- For `base_url`, optionally enforce `https://` in production mode and reject non-TLS URLs unless an explicit override flag is set. CenterEdge API credentials are sent over this connection.

### E. SQLite WAL mode for concurrent reads
- Consider enabling WAL journal mode (`PRAGMA journal_mode=WAL`) to allow concurrent reads during writes, which would prevent web requests from blocking while the cron/scheduler writes to the database.

---

## Production Readiness Checklist

- [ ] `PG_ENCRYPTION_KEY` environment variable set to 64+ hex characters and backed up securely.
- [ ] `PG_APP_DEBUG` environment variable unset or set to a falsy value.
- [ ] `data/` directory owned by the web server runtime user, permissions `770`, not web-browsable.
- [ ] `config.php` permissions set to `640`.
- [ ] `cron.php` scheduled daily via crontab and writing logs to `data/cron.log`.
- [ ] `atd` daemon running; `at` and `atq` commands operational for the web server user.
- [ ] TLS terminated properly at the web server or reverse proxy.
- [ ] Apache `mod_rewrite` enabled with `AllowOverride All` for the application directory.
- [ ] Regular backup of `data/pause_groups.db` (note: also back up `-wal` and `-shm` files if they exist, or run `PRAGMA wal_checkpoint(TRUNCATE)` before backup).
- [ ] `install.php` access restricted or removed after initial setup.

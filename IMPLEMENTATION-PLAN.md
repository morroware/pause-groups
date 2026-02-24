# Pause Group Automation - Implementation Plan

> **Status:** Draft for team review
> **Date:** 2026-02-24
> **API Reference:** `centeredge-cardsystemapi.yaml` (CenterEdge Card System Integration API v1.8.0)

---

## 1. Overview

This project builds a self-contained web application that automates pausing and unpausing games via the CenterEdge Card System API. Entertainment venues need to automatically take groups of games offline on recurring schedules (e.g., redemption games paused during weekday mornings, all games paused overnight) with admin override capability for special events (birthday parties, corporate events, maintenance windows, etc.).

### What It Does

- **Select games by category or individually** from the CenterEdge system and organize them into named "pause groups"
- **Set recurring weekly schedules** (day-of-week + time windows) that automatically pause and unpause games
- **Create temporary overrides** for special events that take precedence over regular schedules
- **Provide a dashboard** showing real-time game status, active schedules, and recent actions
- **Log every action** for audit and troubleshooting

### Key CenterEdge API Endpoints Used

| Endpoint | Method | Purpose |
|---|---|---|
| `/login` | POST | Authenticate (SHA-1 hash), get bearer token |
| `/games` | GET | List all games with status, categories |
| `/games/categories` | GET | List game categories (Redemption, Non-Redemption, etc.) |
| `/games` | PATCH | Bulk update game `operationStatus` (enabled/paused/outOfService) |
| `/capabilities` | GET | Verify system supports operation status management |

### Tech Stack

| Component | Choice | Rationale |
|---|---|---|
| Backend | Plain PHP (no framework) | Easy to deploy, runs anywhere PHP is available |
| Frontend | Vanilla JS/CSS/HTML | No build step, no dependencies |
| Database | SQLite | Zero config, single file, no external DB server |
| Scheduling | System cron (every minute) | Most reliable, standard on all Linux/Mac servers |
| Admin Auth | Username/password with individual accounts | Supports multiple admins with audit trail |

### Requirements

- PHP 7.4+ with extensions: `sqlite3`, `curl`, `json`, `openssl`, `mbstring`
- Web server (Apache with mod_rewrite, or Nginx)
- Cron access
- Network connectivity to the CenterEdge API

---

## 2. File Structure

```
pause-groups/
├── config.php                    # Encryption key, DB path, timezone defaults
├── index.php                     # Main router (serves SPA shell + dispatches API requests)
├── cron.php                      # Cron job entry point (runs every minute)
├── install.php                   # One-time guided setup (CLI or browser)
├── .htaccess                     # Apache URL rewriting → index.php
│
├── lib/                          # Shared PHP classes
│   ├── db.php                    # SQLite singleton, schema init, parameterized query helpers
│   ├── auth.php                  # Admin session management (login/logout/check)
│   ├── centeredge_client.php     # CenterEdge API client (auth, games, categories, patch)
│   ├── crypto.php                # AES-256-CBC encrypt/decrypt for credentials at rest
│   ├── csrf.php                  # CSRF token generation and validation
│   ├── scheduler.php             # Core scheduling engine (the heart of the system)
│   └── validator.php             # Input validation/sanitization helpers
│
├── api/                          # JSON API endpoint handlers
│   ├── auth.php                  # POST login/logout, GET session status
│   ├── games.php                 # Proxy game/category data from CenterEdge
│   ├── groups.php                # CRUD for pause groups
│   ├── schedules.php             # CRUD for recurring schedules
│   ├── overrides.php             # CRUD for temporary overrides
│   ├── settings.php              # GET/PUT CenterEdge API config + timezone
│   ├── logs.php                  # Paginated action log viewer
│   └── users.php                 # Admin user management
│
├── public/                       # Frontend assets
│   ├── css/
│   │   └── style.css             # All application styles
│   └── js/
│       ├── api.js                # Fetch wrapper with CSRF token injection
│       ├── app.js                # SPA router, navigation, toast notifications
│       ├── login.js              # Login page
│       ├── dashboard.js          # Game status overview + active schedules
│       ├── groups.js             # Pause group management UI
│       ├── schedules.js          # Schedule management (weekly day/time grid)
│       ├── overrides.js          # Override management for special events
│       ├── logs.js               # Action log viewer with filters
│       └── settings.js           # API config + admin user management
│
├── data/                         # Writable directory (protected from web access)
│   ├── .htaccess                 # "Deny from all"
│   └── pause_groups.db           # SQLite database (auto-created on first run)
│
├── centeredge-cardsystemapi.yaml # (existing) API specification
└── centeredge-cardsystemapi.html # (existing) Rendered API docs
```

---

## 3. Database Schema (SQLite)

### 3.1 `admin_users` — Admin accounts

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `username` | TEXT UNIQUE | Login name |
| `password_hash` | TEXT | bcrypt hash |
| `display_name` | TEXT | Shown in UI |
| `is_active` | INTEGER | 1=active, 0=deactivated |
| `created_at` | TEXT | UTC datetime |
| `updated_at` | TEXT | UTC datetime |

### 3.2 `api_config` — CenterEdge API configuration (key/value store)

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | Config key name |
| `value` | TEXT | Config value (may be encrypted) |
| `encrypted` | INTEGER | 1=value is AES-256-CBC encrypted |
| `updated_at` | TEXT | UTC datetime |

**Expected keys:**
- `base_url` — CenterEdge API base URL (e.g., `https://cardapi.example.com/api/v1`)
- `username` — API username (encrypted)
- `password` — API password (encrypted)
- `api_key` — Optional X-Api-Key header (encrypted)
- `timezone` — Schedule timezone (e.g., `America/New_York`)
- `bearer_token` — Cached auth token (encrypted)
- `token_fetched_at` — When token was last obtained

### 3.3 `pause_groups` — Named groupings of games

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `name` | TEXT | Group name (e.g., "Redemption Games") |
| `description` | TEXT | Optional description |
| `is_active` | INTEGER | 1=active, 0=disabled |
| `created_at` | TEXT | UTC datetime |
| `updated_at` | TEXT | UTC datetime |

### 3.4 `pause_group_categories` — Link groups to CenterEdge categories

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `pause_group_id` | INTEGER FK | References pause_groups(id) ON DELETE CASCADE |
| `category_id` | INTEGER | CenterEdge GameCategoryId |
| `category_name` | TEXT | Cached name for display |

All games in linked categories are dynamically included when the schedule runs.

### 3.5 `pause_group_games` — Link groups to individual games

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `pause_group_id` | INTEGER FK | References pause_groups(id) ON DELETE CASCADE |
| `game_id` | TEXT | CenterEdge GameId |
| `game_name` | TEXT | Cached name for display |

For selecting individual games not covered by a category.

### 3.6 `schedules` — Recurring weekly pause windows

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `pause_group_id` | INTEGER FK | References pause_groups(id) ON DELETE CASCADE |
| `day_of_week` | INTEGER | 0=Sunday, 1=Monday, ..., 6=Saturday |
| `start_time` | TEXT | HH:MM in 24h format, local timezone |
| `end_time` | TEXT | HH:MM in 24h format, local timezone |
| `is_active` | INTEGER | 1=active, 0=disabled |
| `created_at` | TEXT | UTC datetime |
| `updated_at` | TEXT | UTC datetime |

**Meaning:** "Pause the games in this group from `start_time` to `end_time` on `day_of_week`."
Outside all active schedule windows, games revert to `enabled`.

**Note:** Schedules don't cross midnight in the PoC. For overnight pauses (e.g., 10 PM to 6 AM), create two entries: 22:00-23:59 on one day and 00:00-06:00 on the next.

### 3.7 `schedule_overrides` — Temporary overrides for special events

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `pause_group_id` | INTEGER FK | References pause_groups(id) ON DELETE CASCADE |
| `name` | TEXT | Override name (e.g., "Birthday Party Override") |
| `action` | TEXT | `pause` or `unpause` |
| `start_datetime` | TEXT | YYYY-MM-DD HH:MM, local timezone |
| `end_datetime` | TEXT | YYYY-MM-DD HH:MM, local timezone |
| `created_by` | INTEGER FK | References admin_users(id) |
| `created_at` | TEXT | UTC datetime |

- An **`unpause` override** means: "Force games ON during this window even if a regular schedule says pause" (e.g., special event where you want all games running)
- A **`pause` override** means: "Force games OFF during this window even if no regular schedule is active" (e.g., unexpected maintenance)

### 3.8 `action_log` — Audit trail

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `timestamp` | TEXT | UTC datetime |
| `source` | TEXT | `cron`, `manual`, or `override` |
| `action` | TEXT | `pause`, `unpause`, or `skip` |
| `pause_group_id` | INTEGER FK | Which group triggered this |
| `game_id` | TEXT | CenterEdge GameId |
| `game_name` | TEXT | Cached for display |
| `details` | TEXT | JSON with extra context |
| `success` | INTEGER | 1=success, 0=error |
| `error_message` | TEXT | Error details if failed |

### 3.9 `game_state_cache` — Last known state of each game

| Column | Type | Notes |
|---|---|---|
| `game_id` | TEXT PK | CenterEdge GameId |
| `game_name` | TEXT | Game display name |
| `operation_status` | TEXT | `enabled`, `paused`, or `outOfService` |
| `categories` | TEXT | JSON array of category IDs |
| `last_synced_at` | TEXT | UTC datetime |

Critical for:
- Detecting `outOfService` games (so the system never overrides them)
- Avoiding redundant API calls (only patch games that need a state change)
- Resolving category membership to game IDs at schedule execution time

---

## 4. Core Logic: The Scheduling Engine

### 4.1 How the Cron Job Works (`cron.php` + `lib/scheduler.php`)

The cron job runs every minute and executes `Scheduler::execute()`:

```
1. Acquire exclusive file lock (prevent overlapping runs)
2. Load timezone from config → date_default_timezone_set()
3. Sync game states: GET /games → update game_state_cache
4. Compute desired states for all managed games
5. Compare desired vs. current states
6. Batch PATCH /games for any needed changes
7. Log all actions to action_log
8. Release lock
```

### 4.2 Priority / Precedence Rules

When determining whether a game should be paused or enabled, the system evaluates in this order:

| Priority | Rule | Example |
|---|---|---|
| **1 (highest)** | `outOfService` games are NEVER touched | A broken Skee-Ball machine stays as-is |
| **2** | Active schedule override for the group | "Birthday Party Override" forces unpause |
| **3** | Active regular schedule for the group | "Weekday morning pause" pauses the games |
| **4 (default)** | No active schedule = games should be `enabled` | Games run normally outside schedule windows |

### 4.3 Conflict Resolution

If a game belongs to multiple pause groups with conflicting schedules:
- **`paused` wins over `enabled`** (conservative approach)
- If ANY group says pause, the game is paused
- A game is only enabled if ALL groups agree it should be enabled

This is the safe default for an entertainment venue — it's better to accidentally leave a game paused than to accidentally enable one that should be off.

### 4.4 State Change Detection

The scheduler avoids redundant API calls:
- Each run syncs the cache from CenterEdge first
- Only games that need a DIFFERENT status than their current one are included in the PATCH
- If nothing needs to change, no API call is made
- This keeps API traffic minimal even running every minute

### 4.5 `computeDesiredStates()` Pseudocode

```
For each active pause group:
    Resolve group → list of game IDs (from categories + individual games)

    Check for active override:
        SELECT FROM schedule_overrides
        WHERE pause_group_id = ? AND start_datetime <= now AND end_datetime > now
        ORDER BY created_at DESC LIMIT 1

    If override exists:
        groupAction = override.action ('pause' or 'unpause')
    Else check for active schedule:
        SELECT FROM schedules
        WHERE pause_group_id = ? AND day_of_week = today AND start_time <= now_time AND end_time > now_time AND is_active = 1

        If schedule exists: groupAction = 'pause'
        Else: groupAction = 'unpause' (default: enabled)

    For each game in group:
        If game is outOfService → skip
        If game already marked 'paused' by another group → keep paused (conflict resolution)
        Else set desired state based on groupAction
```

---

## 5. CenterEdge API Client Details

### 5.1 Authentication Flow

Per the API spec (lines 2356-2392), login uses a SHA-1 hash:

```
1. Generate requestTimestamp in ISO 8601 UTC with milliseconds
2. Concatenate: username + password + requestTimestamp (UTF-8)
3. SHA-1 hash the concatenation (raw binary)
4. Base64 encode the hash
5. POST /login with { username, passwordHash, requestTimestamp }
6. Receive { bearerToken } in response
7. Cache the token (encrypted) in api_config table
```

### 5.2 Token Management

- Cached bearer token is reused for subsequent requests
- Proactively re-authenticate if token is older than 30 minutes
- On 401 response: re-authenticate and retry the request once
- If re-auth also fails: log error and abort gracefully

### 5.3 PATCH /games Request Format

Per the API spec (lines 622-705), the bulk update uses JSON Patch:

```json
{
  "games": {
    "12345678": [
      { "op": "replace", "path": "/operationStatus", "value": "paused" }
    ],
    "12345679": [
      { "op": "replace", "path": "/operationStatus", "value": "enabled" }
    ]
  }
}
```

The response includes:
- `games`: array of successfully updated game objects
- `errors`: map of game IDs to error objects for failed updates

Both are processed — successes update the cache and log normally, failures log with `success=0`.

---

## 6. Frontend Pages

The frontend is a single-page application using hash-based routing. No build tools required.

### 6.1 Login Page
- Username + password form
- Calls `POST /api/auth/login`
- Receives CSRF token on success for subsequent requests

### 6.2 Dashboard
- **Game status grid:** All games with color-coded status badges (green=enabled, amber=paused, red=outOfService)
- **Active schedules summary:** Which groups are currently pausing games and why
- **Active overrides:** Any overrides in effect with countdown timers
- **Quick stats:** Total games, currently paused, currently enabled, outOfService
- **"Sync Now" button:** Force-refresh game states from CenterEdge

### 6.3 Pause Group Management
- **List view:** All groups with member counts and active schedule indicators
- **Create/Edit form:**
  - Name and description
  - Two-pane category selector (available categories ↔ selected categories)
  - Individual game picker (searchable checklist)
  - Active/inactive toggle
- **Delete with confirmation**

### 6.4 Schedule Management
- **Weekly grid view:** Organized by group, showing pause windows as colored blocks per day
- **Create form:** Select group, day(s) of week, start time, end time
- **Bulk create:** "Apply to multiple days" for quick setup (e.g., same time Mon-Fri)
- **Edit/delete** existing schedules

### 6.5 Override Management
- **Sections:** Active Now, Upcoming, Expired
- **Create form:** Select group, name, action (pause/unpause), start datetime, end datetime
- **Delete with confirmation**

### 6.6 Action Log Viewer
- **Paginated table:** Timestamp, Source, Action, Group, Game, Details, Status
- **Filters:** Date range, source (cron/manual/override), group, action type
- **Color-coded:** Green for success, red for errors

### 6.7 Settings
- **CenterEdge API config:** Base URL, username, password, API key
- **"Test Connection" button:** Verifies connectivity and capabilities
- **Timezone selector:** Dropdown of common timezones
- **Admin user management:** Create/edit/deactivate admin accounts

---

## 7. Security Measures

| Concern | Mitigation |
|---|---|
| **CSRF** | Per-session token, sent via `X-CSRF-Token` header, validated with timing-safe `hash_equals()` |
| **Session hijacking** | HttpOnly + SameSite=Strict cookies, session ID regenerated on login, server-side 2h timeout |
| **SQL injection** | All queries use parameterized prepared statements via SQLite3Stmt |
| **XSS** | Frontend uses `textContent` (not `innerHTML`) for user-generated content |
| **Credentials at rest** | API password, API key, and bearer token stored AES-256-CBC encrypted in DB |
| **Config file exposure** | `config.php` should be chmod 640; `data/` directory protected by .htaccess |
| **Cron abuse** | `cron.php` checks `php_sapi_name() !== 'cli'` and rejects web requests |
| **Concurrent cron** | File locking (`flock` with `LOCK_NB`) prevents overlapping executions |
| **Brute force login** | `sleep(1)` on failed login attempts |

---

## 8. Installation Process

```bash
# 1. Extract/clone files to web server directory
cp -r pause-groups/ /var/www/pause-groups/

# 2. Edit config.php — set a random encryption key
#    Generate one with: php -r "echo bin2hex(random_bytes(16));"
nano /var/www/pause-groups/config.php

# 3. Set file permissions
mkdir -p /var/www/pause-groups/data
chmod 770 /var/www/pause-groups/data
chmod 640 /var/www/pause-groups/config.php

# 4. Run the installer (creates DB, first admin, API config)
php /var/www/pause-groups/install.php
# Or navigate to http://yourserver/pause-groups/install.php in a browser

# 5. Configure cron (run scheduler every minute)
crontab -e
# Add: * * * * * /usr/bin/php /var/www/pause-groups/cron.php >> /var/www/pause-groups/data/cron.log 2>&1

# 6. Configure web server URL rewriting
# Apache: .htaccess is included (needs mod_rewrite + AllowOverride)
# Nginx: see example config below
```

### Nginx Example Config
```nginx
location /pause-groups {
    try_files $uri $uri/ /pause-groups/index.php?$query_string;

    location ~ \.php$ {
        fastcgi_pass unix:/var/run/php/php-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }

    location /pause-groups/data {
        deny all;
    }
}
```

---

## 9. Implementation Phases

### Phase 1 — Foundation (no external dependencies)
1. `config.php` — Static configuration
2. `lib/db.php` — Database layer with full schema creation
3. `lib/crypto.php` — AES-256-CBC encryption utilities
4. `lib/validator.php` — Input validation helpers
5. `lib/csrf.php` — CSRF token management
6. `lib/auth.php` — Admin session authentication

### Phase 2 — CenterEdge Integration
7. `lib/centeredge_client.php` — API client (auth, games, categories, patch)
8. `api/settings.php` — Store/retrieve API configuration
9. `api/games.php` — Proxy game and category data from CenterEdge

### Phase 3 — Core Data Model
10. `api/groups.php` — Pause group CRUD
11. `api/schedules.php` — Schedule CRUD
12. `api/overrides.php` — Override CRUD

### Phase 4 — Scheduling Engine
13. `lib/scheduler.php` — Core scheduling logic
14. `cron.php` — Cron entry point with file locking

### Phase 5 — Router + Frontend
15. `index.php` — Main router
16. `.htaccess` + `data/.htaccess` — Web server config
17. `public/css/style.css` — All styles
18. Frontend JS modules (api → app → login → dashboard → groups → schedules → overrides → logs → settings)

### Phase 6 — Setup + Polish
19. `install.php` — Guided first-run setup
20. `api/logs.php` — Action log API
21. `api/users.php` — Admin user management
22. `api/auth.php` — Auth API endpoints

---

## 10. Edge Cases and Design Decisions

### Games marked `outOfService`
The system **never** touches games with `outOfService` status. These are games that are broken or deliberately taken out of service by a technician. The scheduler logs a `skip` action when it encounters one. Once the game is fixed and set back to `enabled` or `paused` by an operator, the scheduler will manage it again on its next run.

### Token expiration
Bearer tokens may expire at any time. The client proactively refreshes after 30 minutes and retries once on 401 responses. Double 401 failures are logged and the cron run aborts gracefully without changing any game states.

### Overlapping overrides
If multiple overrides for the same group overlap in time, the most recently created one takes precedence. Expired overrides are not deleted (kept for audit) but are ignored by the scheduler.

### Game in multiple groups with conflicting schedules
The `paused` state wins (conservative). If any active group says a game should be paused, it is paused. This prevents accidental enabling of games that should be off.

### Midnight-spanning schedules
For this PoC, individual schedules cannot span midnight (e.g., 22:00 to 06:00 on a single entry). Instead, create two schedule entries: 22:00-23:59 on one day and 00:00-06:00 on the next. This is clearly documented in the UI. A future enhancement could add native overnight schedule support.

### Network failures
All HTTP requests have a 30-second timeout. Failures are caught, logged to `action_log`, and the cron run continues. No game states are changed if the API is unreachable.

### Concurrent cron execution
File locking ensures only one cron instance runs at a time. If a previous run is still executing (e.g., slow API response), the new run logs "already running" and exits cleanly.

### First run with no configuration
The database auto-creates tables on first access. If API credentials are not configured, the CenterEdge client throws an error that is caught and logged. The web UI redirects to the settings page. The `install.php` script provides guided setup.

---

## 11. Verification Plan

| # | Test | Expected Result |
|---|---|---|
| 1 | Run `php install.php` | Creates DB, prompts for admin + API config, tests CenterEdge connectivity |
| 2 | Login via browser | Session persists, CSRF token required on mutations |
| 3 | Settings → "Test Connection" | Games and categories load from CenterEdge |
| 4 | Create a pause group with a category | Games from that category are listed as members |
| 5 | Create schedule for "now" → run `php cron.php` | Games are paused; action log shows entries |
| 6 | Create "unpause" override during active schedule → run cron | Games are unpaused despite schedule |
| 7 | Set a game to outOfService in CenterEdge → run cron | Game is skipped in the log |
| 8 | Delete cached bearer_token from DB → run cron | Re-authenticates automatically |
| 9 | Run two `php cron.php` instances simultaneously | Second exits with "already running" |
| 10 | Delete an override → run cron | Schedule takes effect again normally |

---

## 12. Future Enhancements (Out of Scope for PoC)

- Overnight schedule support (cross-midnight)
- Email/SMS notifications when games fail to pause/unpause
- Calendar view for visualizing schedules
- Bulk schedule templates (e.g., "Standard Weekday", "Weekend Hours")
- API rate limiting and retry with exponential backoff
- Multi-site support (multiple CenterEdge API endpoints)
- Role-based access control (viewer vs. editor vs. admin)
- Webhook integration for external monitoring
- Docker container for simplified deployment

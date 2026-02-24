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
| Scheduling | Daily cron + `at` command | Cron plans the day once; `at` fires actions at exact times |
| Admin Auth | Username/password with individual accounts | Supports multiple admins with audit trail |

### Requirements

- PHP 7.4+ with extensions: `sqlite3`, `curl`, `json`, `openssl`, `mbstring`
- Web server (Apache with mod_rewrite, or Nginx)
- Cron access (single daily job)
- `at` command / `atd` daemon (for precise timed action execution)
- Network connectivity to the CenterEdge API

---

## 2. File Structure

```
pause-groups/
├── config.php                    # Encryption key, DB path, timezone defaults
├── index.php                     # Main router (serves SPA shell + dispatches API requests)
├── cron.php                      # Daily cron: plans the day's actions + queues via `at`
├── run_action.php                # Executes a single scheduled action (called by `at`)
├── install.php                   # One-time guided setup (CLI or browser)
├── .htaccess                     # Apache URL rewriting → index.php
│
├── lib/                          # Shared PHP classes
│   ├── db.php                    # SQLite singleton, schema init, parameterized query helpers
│   ├── auth.php                  # Admin session management (login/logout/check)
│   ├── centeredge_client.php     # CenterEdge API client (auth, games, categories, patch)
│   ├── crypto.php                # AES-256-CBC encrypt/decrypt for credentials at rest
│   ├── csrf.php                  # CSRF token generation and validation
│   ├── scheduler.php             # Core engine: plan day, queue `at` jobs, execute actions
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

### 3.9 `scheduled_actions` — Queued actions for today (planned by daily cron)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `pause_group_id` | INTEGER FK | Which group this action is for |
| `action` | TEXT | `pause` or `unpause` |
| `scheduled_time` | TEXT | HH:MM — when this action should fire |
| `scheduled_date` | TEXT | YYYY-MM-DD — which day |
| `source` | TEXT | `schedule`, `override`, or `replan` |
| `at_job_id` | TEXT | `at` job identifier for cancellation |
| `executed` | INTEGER | 0=pending, 1=done, 2=failed |
| `executed_at` | TEXT | When it actually ran |
| `created_at` | TEXT | UTC datetime |

This table is rebuilt daily by `cron.php`. Each row maps to one `at` job. When an admin creates an override or changes a schedule, the remaining unexecuted actions for today are cleared, replanned, and requeued.

### 3.10 `game_state_cache` — Last known state of each game

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

### 4.1 Two-Part Architecture: Daily Planner + Timed Execution

The scheduling system uses a **"plan the day"** model rather than frequent polling:

**Part 1 — Daily Cron (`cron.php`)** runs once per day (e.g., midnight):
```
1. Acquire exclusive file lock
2. Load timezone from config
3. Sync game states: GET /games → update game_state_cache
4. Compute all transition points for today:
   - Which groups need to be paused and when (from schedules table, filtered by today's day_of_week)
   - Which groups need to be unpaused and when
   - Any overrides active today (by date/time range)
5. Write planned actions to scheduled_actions table
6. Clear any previously queued `at` jobs (tagged with app identifier)
7. Queue each action via `at`:
   echo "php /path/run_action.php --id 42" | at 09:00
   echo "php /path/run_action.php --id 43" | at 17:00
8. Log the day plan to action_log
9. Release lock
```

**Part 2 — Timed Execution (`run_action.php`)** fires at exact scheduled times via `at`:
```
1. Load the scheduled action by ID from scheduled_actions table
2. Sync game states from CenterEdge (fresh check)
3. Skip any outOfService games
4. Call PATCH /games for the required state changes
5. Mark the action as executed in scheduled_actions
6. Log results to action_log
```

**Part 3 — Immediate Execution (admin UI actions)**:
When an admin creates an override, manually pauses/unpauses, or changes schedules:
```
1. Save the change to the database
2. Immediately execute Scheduler::executeAction() for the affected games
3. Replan remaining actions for today (clear + requeue `at` jobs)
```

This gives you:
- **Precise timing** — actions fire at the exact scheduled time
- **Minimal API traffic** — only calls CenterEdge at transition points, not every few minutes
- **Instant overrides** — admin actions take effect immediately, not at next poll
- **Single daily cron** — no frequent cron jobs needed

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
- Each action execution syncs the cache from CenterEdge first (fresh state check)
- Only games that need a DIFFERENT status than their current one are included in the PATCH
- If nothing needs to change, no API call is made
- API calls only happen at transition points (typically 2-4 per day), not on a polling loop

### 4.5 `planDay()` Pseudocode — How the Daily Cron Plans Actions

```
Input: target_date (today)
Output: list of scheduled_actions to queue via `at`

actions = []
today_dow = day_of_week(target_date)  // 0=Sun..6=Sat

For each active pause group:
    // Check for overrides active on this date
    overrides = SELECT FROM schedule_overrides
        WHERE pause_group_id = group.id
          AND DATE(start_datetime) <= target_date
          AND DATE(end_datetime) >= target_date

    // Get today's recurring schedules
    schedules = SELECT FROM schedules
        WHERE pause_group_id = group.id
          AND day_of_week = today_dow
          AND is_active = 1

    // Build transition points for this group:
    For each schedule:
        actions.add(time=schedule.start_time, group=group.id, action='pause', source='schedule')
        actions.add(time=schedule.end_time, group=group.id, action='unpause', source='schedule')

    For each override:
        // Override transitions may replace schedule transitions
        if override starts today:
            actions.add(time=TIME(override.start_datetime), group=group.id, action=override.action, source='override')
        if override ends today:
            // Revert to what the schedule says at that point
            actions.add(time=TIME(override.end_datetime), group=group.id, action=reverse(override.action), source='override')

// Sort all actions by time
// Remove duplicate/conflicting actions (override wins over schedule at same time)
// Filter out actions whose time has already passed today
// Write to scheduled_actions table
// Queue each via: echo "php run_action.php --id {action.id}" | at {action.time}
```

### 4.6 `executeAction()` Pseudocode — How Each Timed Action Runs

```
Input: scheduled_action_id
1. Load action from scheduled_actions table
2. Sync game states from CenterEdge API (fresh check)
3. Resolve group → game IDs (categories + individual games)
4. For each game:
   - If outOfService → skip, log
   - If already in desired state → skip
   - Else add to change batch
5. PATCH /games with change batch
6. Update game_state_cache
7. Mark action as executed in scheduled_actions
8. Log all results to action_log
9. Check for any missed earlier actions → execute them too
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
| **CLI-only scripts** | `cron.php` and `run_action.php` check `php_sapi_name() !== 'cli'` and reject web requests |
| **Concurrent execution** | File locking (`flock` with `LOCK_NB`) on action execution prevents overlapping state changes |
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

# 5. Ensure atd is running (for timed action execution)
sudo systemctl enable atd
sudo systemctl start atd

# 6. Configure daily cron (plans the day's actions at midnight)
crontab -e
# Add: 0 0 * * * /usr/bin/php /var/www/pause-groups/cron.php >> /var/www/pause-groups/data/cron.log 2>&1
# Run once manually to plan today: php /var/www/pause-groups/cron.php

# 7. Configure web server URL rewriting
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
13. `lib/scheduler.php` — Core scheduling logic (day planning + action execution)
14. `cron.php` — Daily cron: plans the day, queues `at` jobs
15. `run_action.php` — Single action executor (called by `at` at scheduled times)

### Phase 5 — Router + Frontend
16. `index.php` — Main router
17. `.htaccess` + `data/.htaccess` — Web server config
18. `public/css/style.css` — All styles
19. Frontend JS modules (api → app → login → dashboard → groups → schedules → overrides → logs → settings)

### Phase 6 — Setup + Polish
20. `install.php` — Guided first-run setup
21. `api/logs.php` — Action log API
22. `api/users.php` — Admin user management
23. `api/auth.php` — Auth API endpoints

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
All HTTP requests have a 30-second timeout. Failures are caught, logged to `action_log`, and the action is marked as failed in `scheduled_actions`. A failed action can be retried from the admin UI. No game states are changed if the API is unreachable.

### `at` job management
Each daily plan clears previously queued `at` jobs (tagged with the app name) before scheduling new ones. When an admin creates an override or modifies schedules mid-day, the system replans: cancels remaining unexecuted `at` jobs, recomputes the rest of today's transition points, and queues new `at` jobs. The `scheduled_actions` table tracks each job's state so nothing gets lost.

### Server restart / missed `at` jobs
If the server restarts and `at` jobs are lost, the daily cron at midnight replans everything. If an admin notices games are in the wrong state mid-day, the "Sync & Replan" button in the dashboard forces an immediate replan. As a safety net, each `run_action.php` execution also checks if any earlier actions were missed and executes them.

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
| 5 | Create schedule for today → run `php cron.php` | `at` jobs are queued; `atq` shows them |
| 6 | Wait for scheduled time to pass | `run_action.php` fires, games are paused, action_log updated |
| 7 | Create "unpause" override → verify immediate execution | Games unpause instantly, `at` jobs replanned |
| 8 | Set a game to outOfService in CenterEdge → trigger action | Game is skipped in the log |
| 9 | Delete cached bearer_token from DB → trigger action | Re-authenticates automatically |
| 10 | Reboot server, then run `php cron.php` | Missed actions detected and executed, day replanned |
| 11 | Delete an override mid-day | Remaining `at` jobs replanned, schedule takes effect |

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

# Pause Group Automation

A web application for scheduling and managing pause/unpause operations on arcade game groups via the CenterEdge Card System API. 
## Requirements

| Requirement | Purpose |
|-------------|---------|
| PHP 7.4+ | Runtime (CLI and web) |
| SQLite3 extension | Database |
| OpenSSL extension | AES-256-CBC credential encryption |
| mbstring extension | Installer/runtime string handling |
| cURL extension | CenterEdge API communication |
| Linux `at` + `atrm` commands (optional) | Native per-action queueing; fallback mode works without these |
| Apache or Nginx | Web server (with PHP-FPM or mod_php) |
| Cron daemon (recommended) | Reliable planning + watchdog execution |

No external PHP dependencies. Everything uses the standard library.

## Hosting Compatibility

This app is designed to run across common environments:

- **cPanel/shared hosting**: run with PHP + SQLite + cron. If `at` is unavailable, schedules still execute through `cron_watchdog.php` (minute cadence) and missed-action checks.
- **VPS / dedicated Linux**: use both cron jobs plus `at`/`atrm` for native queued execution.
- **Raspberry Pi (Ubuntu Server)**: same as VPS; install `at` if desired for native queueing.

In short: `at` improves execution precision, but it is **not required** for the application to function.

## Installation

Run the installer from the command line:

```bash
php install.php
```

This creates the SQLite database, prompts for an admin user, and optionally configures CenterEdge API credentials. To reset and start fresh:

```bash
php install.php --reset
```

### Environment Variables

- `PG_ENCRYPTION_KEY` -- 32-byte hex key used for encrypting stored API credentials.
- `PG_APP_DEBUG` -- Set to `true` to enable verbose error output. Do not enable in production.

### Cron Setup

Use the following crontab entries (project path example: `/var/www/html/ce/pause-groups-main/`):

```
* * * * * /usr/bin/php /var/www/html/ce/pause-groups-main/cron_watchdog.php >> /var/www/html/ce/pause-groups-main/data/watchdog.log 2>&1
5 0 * * * /usr/bin/php /var/www/html/ce/pause-groups-main/cron.php >> /var/www/html/ce/pause-groups-main/data/cron.log 2>&1
```

`cron_watchdog.php` is a reliability safety net (missed-action execution, state enforcement, cache refresh, and at-job requeue). `cron.php` performs the daily plan build and queueing.

If `at`/`atrm` are not installed, keep the watchdog cron enabled (every minute). In that mode, due actions are executed when watchdog runs rather than through native `at` jobs.

## Architecture

PHP backend with a vanilla JavaScript single-page application frontend. SQLite database. No frameworks.

```
pause-groups/
  index.php              # Router: serves SPA shell and dispatches API requests
  config.php             # Timezone, encryption, session configuration
  install.php            # First-run setup (CLI and web modes)
  cron.php               # Daily cron job: syncs games, plans day, queues at jobs
  run_action.php         # Action executor invoked by at jobs

  api/                   # API endpoint handlers
    auth.php             #   Login, logout, session status
    settings.php         #   CenterEdge API configuration
    games.php            #   Game and category data
    groups.php           #   Pause group CRUD
    schedules.php        #   Recurring schedule CRUD
    overrides.php        #   Temporary override CRUD
    logs.php             #   Action log viewer
    users.php            #   Admin user management

  lib/                   # Core libraries
    db.php               #   SQLite singleton, schema initialization
    auth.php             #   Session management
    csrf.php             #   CSRF token handling
    crypto.php           #   AES-256-CBC encryption
    validator.php        #   Input validation
    centeredge_client.php  # CenterEdge API client
    scheduler.php        #   Scheduling engine

  public/                # Frontend assets
    js/                  #   SPA modules (api, app, dashboard, groups, etc.)
    css/                 #   Stylesheet (dark theme)

  data/                  # Runtime data (created by installer)
    pause_groups.db      #   SQLite database
    .scheduler.lock      #   Concurrency lock file
    cron.log             #   Cron output
```

## Core Concepts

### Pause Groups

A pause group is a named collection of games. Games can be added individually or by CenterEdge category. A single group can contain both.

### Schedules

Recurring weekly pause windows attached to a group. Each schedule defines a day of week, start time, and end time. The scheduler generates pause and unpause actions at the start and end of each window.

### Overrides

Temporary, date-bounded pause or unpause periods that take precedence over recurring schedules. When an override conflicts with a schedule, the override wins.

### Daily Planning

The cron job runs once per day and:

1. Syncs the game list from CenterEdge into a local cache.
2. Computes all scheduled actions for the day by merging recurring schedules with active overrides.
3. Queues each action as a Linux `at` job when available; otherwise actions are executed by watchdog/missed-action processing once due.

When schedules or overrides are modified through the UI, the system replans the remainder of the day automatically.

### Game Sync Behavior

Game and status data is refreshed from CenterEdge in multiple ways:

1. **Daily cron (`cron.php`)** performs a full sync before planning actions.
2. **Watchdog cron (`cron_watchdog.php`)** performs one sync each watchdog cycle before enforcing desired states.
3. **Dashboard "Sync Now" button** calls `POST /api/games/sync` to force an immediate refresh.
4. **`GET /api/games` auto-primes cache** by running a sync if the cache is empty.

The dashboard itself auto-refreshes every 60 seconds, but that refresh reads the existing cache unless one of the sync paths above runs.

### Action Execution

When `at` is available, each `at` job invokes `run_action.php`. In fallback mode (no `at`), the watchdog/missed-action path invokes the same scheduler logic. Core execution behavior is:

1. Resolves the pause group to a list of game IDs.
2. Checks current game states from the local cache.
3. Skips games that are already in the target state or out of service.
4. Sends a PATCH request to the CenterEdge API to update game states.
5. Logs the result of each game state change.

File locking prevents concurrent execution of overlapping actions.

## API

All endpoints return JSON. State-changing requests (POST, PUT, DELETE) require a valid `X-CSRF-Token` header. Authentication is session-based via HttpOnly cookies.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Authenticate |
| `/api/auth/logout` | POST | End session |
| `/api/auth/status` | GET | Check session validity |
| `/api/settings` | GET | Read API configuration |
| `/api/settings` | PUT | Update API configuration |
| `/api/settings/test` | POST | Test CenterEdge connection |
| `/api/games` | GET | List cached games (auto-syncs if cache is empty) |
| `/api/games/categories` | GET | List game categories |
| `/api/games/sync` | POST | Force game cache refresh |
| `/api/groups` | GET, POST | List or create pause groups |
| `/api/groups/{id}` | GET, PUT, DELETE | Read, update, or delete a group |
| `/api/schedules` | GET, POST | List or create schedules |
| `/api/schedules/{id}` | PUT, DELETE | Update or delete a schedule |
| `/api/overrides` | GET, POST | List or create overrides |
| `/api/overrides/{id}` | DELETE | Delete an override |
| `/api/logs` | GET | Query action log (supports filtering and pagination) |
| `/api/users` | GET, POST | List or create admin users |
| `/api/users/{id}` | PUT | Update a user |

## CenterEdge Integration

The application authenticates with the CenterEdge Card System API using SHA-1 hashed credentials and bearer tokens. Tokens are cached with a 30-minute TTL and refreshed automatically on 401 responses. API credentials are stored encrypted at rest using AES-256-CBC.

## Security Notes

- All SQL queries use parameterized statements.
- CSRF protection on all state-changing endpoints.
- Passwords hashed with bcrypt.
- Session cookies set to HttpOnly and SameSite=Strict.
- API credentials encrypted at rest.
- CLI-only guards on cron and action runner scripts.
- File locking prevents concurrent action execution.

### Production Deployment

- Block `install.php` via web server configuration after initial setup.
- Set `PG_ENCRYPTION_KEY` as an environment variable.
- Enforce HTTPS.
- Restrict `data/` directory permissions to the application user.
- Monitor the cron job and configure alerting for API failures.

## Development

Start a local server:

```bash
php -S localhost:8000
```

Run the installer, configure CenterEdge API credentials through the settings page, and trigger a game sync. The installer now preflights required PHP extensions and warns if `at`/`atrm` are unavailable. The application uses hash-based routing (`#/dashboard`, `#/groups`, etc.).

There is no automated test suite.

<?php
/**
 * Watchdog cron: catches missed actions and re-queues broken at jobs.
 * Run every 5 minutes as a safety net alongside the daily cron.
 *
 * Usage: php cron_watchdog.php
 * Crontab: */5 * * * * /usr/bin/php /path/to/pause-groups/cron_watchdog.php >> /path/to/pause-groups/data/watchdog.log 2>&1
 */

// CLI-only guard
if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('This script can only be run from the command line.');
}

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/crypto.php';
require_once __DIR__ . '/lib/centeredge_client.php';
require_once __DIR__ . '/lib/scheduler.php';

// Ensure data directory exists
$dataDir = dirname(DB_PATH);
if (!is_dir($dataDir)) {
    mkdir($dataDir, 0770, true);
}

// Acquire exclusive file lock (non-blocking — skip if another instance is running)
$lockFile = fopen(LOCK_FILE, 'c');
if (!$lockFile || !flock($lockFile, LOCK_EX | LOCK_NB)) {
    // Another process holds the lock — skip this run silently
    exit(0);
}

try {
    $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
    date_default_timezone_set($tz);
    $today = date('Y-m-d');

    // Execute any missed actions (scheduled time has passed but not yet executed)
    Scheduler::executeMissedActions($today);

    // Re-queue any actions that are missing their at jobs
    // (pending, future, but no at_job_id — can happen if at failed silently)
    Scheduler::queueAtJobs($today);

} catch (Exception $e) {
    $msg = "[" . date('c') . "] watchdog error: " . $e->getMessage() . "\n";
    echo $msg;
    error_log($msg);
    exit(1);
} finally {
    flock($lockFile, LOCK_UN);
    fclose($lockFile);
}

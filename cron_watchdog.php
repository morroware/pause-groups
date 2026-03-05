<?php
/**
 * Watchdog cron: catches missed actions and re-queues broken at jobs.
 * Run every minute as a safety net alongside the daily cron.
 *
 * Usage: php cron_watchdog.php
 * Crontab: * * * * * /usr/bin/php /var/www/html/ce/pause-groups-main/cron_watchdog.php >> /var/www/html/ce/pause-groups-main/data/watchdog.log 2>&1
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

// Acquire exclusive file lock with a short blocking wait.
// Previous behavior: non-blocking skip.  Problem: if cron.php or run_action.php
// held the lock for even a few seconds the watchdog would silently do nothing,
// causing missed actions and delayed enforcement.  Now we retry for up to 15s
// so the watchdog almost always runs within its 1-minute cadence.
$lockFile = fopen(LOCK_FILE, 'c');
if (!$lockFile) {
    exit(0);
}
$lockAcquired = false;
for ($i = 0; $i < 15; $i++) {
    if (flock($lockFile, LOCK_EX | LOCK_NB)) {
        $lockAcquired = true;
        break;
    }
    sleep(1);
}
if (!$lockAcquired) {
    // Another long-running process still holds the lock after 15s — skip this cycle
    fclose($lockFile);
    exit(0);
}

try {
    $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
    date_default_timezone_set($tz);
    $today = date('Y-m-d');

    // Execute any missed actions (scheduled time has passed but not yet executed)
    Scheduler::executeMissedActions($today);

    // Enforce the live desired state as a fallback when queued jobs are delayed/missing.
    Scheduler::enforceCurrentStates();

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

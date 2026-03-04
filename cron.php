<?php
/**
 * Daily cron job: syncs game states, plans the day's actions, queues at jobs.
 * Run once per day (recommended: 00:05).
 *
 * Usage: php cron.php
 * Crontab: 5 0 * * * /usr/bin/php /var/www/html/ce/pause-groups-main/cron.php >> /var/www/html/ce/pause-groups-main/data/cron.log 2>&1
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
    echo "[" . date('c') . "] Another instance is already running. Exiting.\n";
    exit(0);
}

try {
    // Load timezone
    $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
    date_default_timezone_set($tz);
    $today = date('Y-m-d');

    echo "[" . date('c') . "] === Daily Plan for $today (TZ: $tz) ===\n";

    // Step 1: Sync game states from CenterEdge
    echo "Syncing game states from CenterEdge...\n";
    try {
        $count = Scheduler::syncGameStates();
        echo "  Synced $count games.\n";
    } catch (Exception $e) {
        echo "  WARNING: Game sync failed: " . $e->getMessage() . "\n";
        echo "  Continuing with cached data...\n";
    }

    // Step 2: Execute any missed actions from earlier
    echo "Checking for missed actions...\n";
    Scheduler::executeMissedActions($today);

    // Step 3: Plan today's actions
    echo "Planning actions for $today...\n";
    $actions = Scheduler::planDay($today);
    echo "  Planned " . count($actions) . " actions:\n";
    foreach ($actions as $a) {
        echo "    {$a['time']} - {$a['action']} - {$a['group_name']} ({$a['source']})\n";
    }

    // Step 4: Queue at jobs (if available on this host)
    echo "Queuing at jobs (or fallback mode if at/atrm unavailable)...\n";
    Scheduler::queueAtJobs($today);
    echo "  Done.\n";

    echo "[" . date('c') . "] === Daily plan complete ===\n\n";

} catch (Exception $e) {
    $msg = "[" . date('c') . "] FATAL ERROR: " . $e->getMessage() . "\n";
    echo $msg;
    error_log($msg);

    // Log the error to action_log
    try {
        DB::execute(
            'INSERT INTO action_log (source, action, success, error_message, details)
             VALUES (:p0, :p1, :p2, :p3, :p4)',
            ['cron', 'plan_day', 0, $e->getMessage(), json_encode(['trace' => $e->getTraceAsString()])]
        );
    } catch (Exception $logE) {
        // Can't log — just output
        echo "Failed to log error: " . $logE->getMessage() . "\n";
    }

    exit(1);
} finally {
    flock($lockFile, LOCK_UN);
    fclose($lockFile);
}

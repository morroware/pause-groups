<?php
/**
 * Core scheduling engine.
 * Handles day planning, action execution, at-job management, and conflict resolution.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/crypto.php';
require_once __DIR__ . '/centeredge_client.php';

class Scheduler {
    /**
     * Plan all actions for a given date.
     * Computes transition points, resolves conflicts, writes to scheduled_actions, queues at jobs.
     * Returns array of planned actions.
     */
    public static function planDay(?string $date = null): array {
        $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
        date_default_timezone_set($tz);

        if ($date === null) {
            $date = date('Y-m-d');
        }
        $todayDow = (int)(new DateTime($date))->format('w'); // 0=Sunday

        // Clear existing pending actions for this date
        self::clearPendingActions($date);

        $actions = [];

        // Get all active pause groups
        $groups = DB::query('SELECT id, name FROM pause_groups WHERE is_active = 1');

        foreach ($groups as $group) {
            $groupId = $group['id'];

            // Get today's recurring schedules for this group
            $schedules = DB::query(
                'SELECT * FROM schedules WHERE pause_group_id = :p0 AND day_of_week = :p1 AND is_active = 1',
                [$groupId, $todayDow]
            );

            // Get overrides active on this date
            $overrides = DB::query(
                'SELECT * FROM schedule_overrides WHERE pause_group_id = :p0
                 AND DATE(start_datetime) <= :p1 AND DATE(end_datetime) >= :p1',
                [$groupId, $date]
            );

            // Build transition points from schedules
            $transitions = [];
            foreach ($schedules as $sched) {
                $transitions[] = [
                    'time'   => $sched['start_time'],
                    'action' => 'pause',
                    'source' => 'schedule',
                    'priority' => 0,
                ];
                $transitions[] = [
                    'time'   => $sched['end_time'],
                    'action' => 'unpause',
                    'source' => 'schedule',
                    'priority' => 0,
                ];
            }

            // Build transition points from overrides (higher priority)
            foreach ($overrides as $override) {
                $startDt = new DateTime($override['start_datetime']);
                $endDt = new DateTime($override['end_datetime']);
                $startDate = $startDt->format('Y-m-d');
                $endDate = $endDt->format('Y-m-d');

                // If override starts today, add start transition
                if ($startDate === $date) {
                    $transitions[] = [
                        'time'   => $startDt->format('H:i'),
                        'action' => $override['action'],
                        'source' => 'override',
                        'priority' => 1,
                    ];
                }

                // If override ends today, restore to the correct state.
                // Check other overrides first, then fall back to the recurring schedule.
                if ($endDate === $date) {
                    $endTime = $endDt->format('H:i');

                    // Check if another override is still active at the end time
                    $restoreAction = null;
                    foreach ($overrides as $other) {
                        if ($other['id'] === $override['id']) {
                            continue;
                        }
                        $otherStart = new DateTime($other['start_datetime']);
                        $otherEnd = new DateTime($other['end_datetime']);
                        $otherStartStr = $otherStart->format('Y-m-d H:i');
                        $otherEndStr = $otherEnd->format('Y-m-d H:i');
                        $endFullStr = $endDt->format('Y-m-d H:i');
                        if ($otherStartStr <= $endFullStr && $otherEndStr > $endFullStr) {
                            $restoreAction = $other['action'];
                            break;
                        }
                    }

                    // No other override active — fall back to the recurring schedule
                    if ($restoreAction === null) {
                        $restoreAction = 'unpause'; // default: enabled
                        foreach ($schedules as $sched) {
                            if ($sched['start_time'] <= $endTime && $sched['end_time'] > $endTime) {
                                $restoreAction = 'pause';
                                break;
                            }
                        }
                    }

                    $transitions[] = [
                        'time'   => $endTime,
                        'action' => $restoreAction,
                        'source' => 'override',
                        'priority' => 1,
                    ];
                }
            }

            // Suppress schedule transitions that fall during an active override window.
            // Overrides take priority for their entire duration, not just at their
            // exact start/end times. Any recurring-schedule transition that would
            // fire while an override is active must be dropped so it cannot
            // contradict the override (e.g. an unpause from a schedule ending
            // while a pause-override is still active).
            $filtered = [];
            foreach ($transitions as $t) {
                if ($t['source'] === 'schedule') {
                    $checkTime = $date . ' ' . $t['time'];
                    foreach ($overrides as $override) {
                        if ($override['start_datetime'] <= $checkTime && $override['end_datetime'] > $checkTime) {
                            continue 2; // Skip this schedule transition
                        }
                    }
                }
                $filtered[] = $t;
            }
            $transitions = $filtered;

            // Sort by time, then by priority (override > schedule)
            usort($transitions, function ($a, $b) {
                $cmp = strcmp($a['time'], $b['time']);
                if ($cmp !== 0) return $cmp;
                return $b['priority'] - $a['priority']; // Higher priority first
            });

            // Deduplicate: at each time, highest priority wins
            $seen = [];
            foreach ($transitions as $t) {
                $key = $t['time'];
                if (!isset($seen[$key]) || $t['priority'] > $seen[$key]['priority']) {
                    $seen[$key] = $t;
                }
            }

            // Filter out past times
            $now = new DateTime('now', new DateTimeZone($tz));
            $nowTime = $now->format('H:i');
            $isToday = ($date === $now->format('Y-m-d'));

            foreach ($seen as $time => $t) {
                if ($isToday && $time <= $nowTime) {
                    continue; // Skip past times
                }

                DB::execute(
                    'INSERT INTO scheduled_actions (pause_group_id, action, scheduled_time, scheduled_date, source)
                     VALUES (:p0, :p1, :p2, :p3, :p4)',
                    [$groupId, $t['action'], $time, $date, $t['source']]
                );
                $actionId = DB::lastInsertId();

                $actions[] = [
                    'id'       => $actionId,
                    'group_id' => $groupId,
                    'group_name' => $group['name'],
                    'action'   => $t['action'],
                    'time'     => $time,
                    'source'   => $t['source'],
                ];
            }
        }

        return $actions;
    }

    /**
     * Clear pending (unexecuted) actions and cancel their at jobs.
     */
    public static function clearPendingActions(?string $date = null): void {
        $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
        date_default_timezone_set($tz);

        if ($date === null) {
            $date = date('Y-m-d');
        }

        // Get pending actions with at_job_id
        $pending = DB::query(
            'SELECT id, at_job_id FROM scheduled_actions WHERE scheduled_date = :p0 AND executed = 0',
            [$date]
        );

        // Cancel at jobs
        foreach ($pending as $action) {
            if (!empty($action['at_job_id'])) {
                self::cancelAtJob($action['at_job_id']);
            }
        }

        // Delete pending actions
        DB::execute(
            'DELETE FROM scheduled_actions WHERE scheduled_date = :p0 AND executed = 0',
            [$date]
        );
    }

    /**
     * Queue pending scheduled actions as at jobs.
     */
    public static function queueAtJobs(?string $date = null): void {
        $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
        date_default_timezone_set($tz);

        if ($date === null) {
            $date = date('Y-m-d');
        }

        $actions = DB::query(
            'SELECT id, scheduled_time FROM scheduled_actions WHERE scheduled_date = :p0 AND executed = 0 AND at_job_id IS NULL',
            [$date]
        );

        $scriptPath = realpath(__DIR__ . '/../run_action.php');

        // Use the full PHP CLI path so at jobs work regardless of PATH
        $phpBin = PHP_BINDIR . '/php';
        if (!file_exists($phpBin)) {
            $phpBin = PHP_BINARY;
        }

        foreach ($actions as $action) {
            $cmd = sprintf(
                'echo "%s %s --id %d" | at %s 2>&1',
                escapeshellarg($phpBin),
                escapeshellarg($scriptPath),
                $action['id'],
                escapeshellarg($action['scheduled_time'])
            );

            $output = [];
            exec($cmd, $output, $exitCode);
            $outputStr = implode("\n", $output);

            $jobId = self::parseAtJobId($outputStr);
            if ($jobId) {
                DB::execute(
                    'UPDATE scheduled_actions SET at_job_id = :p0 WHERE id = :p1',
                    [$jobId, $action['id']]
                );
            } else {
                error_log("Failed to queue at job for action #{$action['id']} at {$action['scheduled_time']}: exit=$exitCode output=$outputStr");
            }
        }
    }

    /**
     * Replan today: clear pending actions, recompute, requeue.
     */
    public static function replanToday(): void {
        $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
        date_default_timezone_set($tz);
        $today = date('Y-m-d');

        self::clearPendingActions($today);
        self::planDay($today);
        self::queueAtJobs($today);
    }

    /**
     * Enforce the desired state for each active group at the current time.
     * This acts as a watchdog fallback when at jobs are delayed or unavailable.
     */
    public static function enforceCurrentStates(): array {
        $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
        date_default_timezone_set($tz);

        $now = new DateTime('now', new DateTimeZone($tz));
        $todayDow = (int)$now->format('w');
        $nowStr = $now->format('Y-m-d H:i');
        $nowTime = $now->format('H:i');

        // One sync for the whole watchdog cycle.
        try {
            self::syncGameStates();
        } catch (Exception $e) {
            error_log('Watchdog sync failed: ' . $e->getMessage());
        }

        $summary = ['groups_checked' => 0, 'groups_enforced' => 0, 'results' => []];
        $groups = DB::query('SELECT id FROM pause_groups WHERE is_active = 1');

        foreach ($groups as $group) {
            $groupId = (int)$group['id'];
            $summary['groups_checked']++;

            // Highest-priority rule: active override wins.
            $activeOverride = DB::queryOne(
                'SELECT action FROM schedule_overrides
                 WHERE pause_group_id = :p0 AND start_datetime <= :p1 AND end_datetime > :p1
                 ORDER BY start_datetime DESC, id DESC LIMIT 1',
                [$groupId, $nowStr]
            );

            $desiredAction = 'unpause';
            $source = 'watchdog';

            if ($activeOverride) {
                $desiredAction = $activeOverride['action'];
                $source = 'override';
            } else {
                $activeSchedule = DB::queryOne(
                    'SELECT id FROM schedules
                     WHERE pause_group_id = :p0 AND day_of_week = :p1 AND is_active = 1
                       AND start_time <= :p2 AND end_time > :p2
                     LIMIT 1',
                    [$groupId, $todayDow, $nowTime]
                );
                if ($activeSchedule) {
                    $desiredAction = 'pause';
                    $source = 'schedule';
                }
            }

            $result = self::executeStateChange(
                $groupId,
                $desiredAction === 'pause' ? 'paused' : 'enabled',
                $source,
                false
            );

            if (!empty($result['changed'])) {
                $summary['groups_enforced']++;
            }

            $summary['results'][$groupId] = $result;
        }

        return $summary;
    }

    /**
     * Enforce the desired state for a single group at the current time.
     * Used after override changes that require immediate state correction.
     */
    public static function enforceGroupState(int $groupId): array {
        $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
        date_default_timezone_set($tz);

        $now = new DateTime('now', new DateTimeZone($tz));
        $todayDow = (int)$now->format('w');
        $nowStr = $now->format('Y-m-d H:i');
        $nowTime = $now->format('H:i');

        // Highest-priority rule: active override wins.
        $activeOverride = DB::queryOne(
            'SELECT action FROM schedule_overrides
             WHERE pause_group_id = :p0 AND start_datetime <= :p1 AND end_datetime > :p1
             ORDER BY start_datetime DESC, id DESC LIMIT 1',
            [$groupId, $nowStr]
        );

        $desiredAction = 'unpause';
        $source = 'schedule';

        if ($activeOverride) {
            $desiredAction = $activeOverride['action'];
            $source = 'override';
        } else {
            $activeSchedule = DB::queryOne(
                'SELECT id FROM schedules
                 WHERE pause_group_id = :p0 AND day_of_week = :p1 AND is_active = 1
                   AND start_time <= :p2 AND end_time > :p2
                 LIMIT 1',
                [$groupId, $todayDow, $nowTime]
            );
            if ($activeSchedule) {
                $desiredAction = 'pause';
                $source = 'schedule';
            }
        }

        return self::executeStateChange(
            $groupId,
            $desiredAction === 'pause' ? 'paused' : 'enabled',
            $source
        );
    }

    /**
     * Execute a single scheduled action by ID.
     * Returns array of results.
     */
    public static function executeAction(int $actionId): array {
        $action = DB::queryOne('SELECT * FROM scheduled_actions WHERE id = :p0', [$actionId]);
        if (!$action) {
            throw new RuntimeException("Scheduled action #$actionId not found.");
        }

        if ($action['executed'] != 0) {
            return ['status' => 'already_executed', 'action_id' => $actionId];
        }

        $groupId = $action['pause_group_id'];
        $desiredAction = $action['action']; // 'pause' or 'unpause'
        $source = $action['source'];
        $desiredStatus = ($desiredAction === 'pause') ? 'paused' : 'enabled';

        $results = self::executeStateChange($groupId, $desiredStatus, $source);

        // Mark action as executed
        $allSuccess = !empty($results['changed']) || (empty($results['errors']));
        DB::execute(
            'UPDATE scheduled_actions SET executed = :p0, executed_at = datetime(\'now\') WHERE id = :p1',
            [$allSuccess ? 1 : 2, $actionId]
        );

        return $results;
    }

    /**
     * Execute an immediate action (for overrides and manual actions).
     */
    public static function executeImmediate(int $groupId, string $action, string $source = 'manual'): array {
        $desiredStatus = ($action === 'pause') ? 'paused' : 'enabled';
        return self::executeStateChange($groupId, $desiredStatus, $source);
    }

    /**
     * Core state change logic: resolve games, check states, patch CenterEdge.
     */
    private static function executeStateChange(int $groupId, string $desiredStatus, string $source, bool $syncCache = true): array {
        $results = ['changed' => [], 'skipped' => [], 'errors' => []];

        try {
            $client = new CenterEdgeClient();

            // Sync fresh game states
            if ($syncCache) {
                $client->syncGamesToCache();
            }

            // Resolve group to game IDs
            $gameIds = self::resolveGroupGames($groupId);

            if (empty($gameIds)) {
                self::logAction($source, $desiredStatus === 'paused' ? 'pause' : 'unpause', $groupId, '', '', true, null, ['note' => 'No games in group']);
                return $results;
            }

            // Get current states from cache
            $changes = [];
            foreach ($gameIds as $gameId) {
                $cached = DB::queryOne('SELECT * FROM game_state_cache WHERE game_id = :p0', [$gameId]);
                if (!$cached) {
                    continue;
                }

                // Never touch outOfService games
                if ($cached['operation_status'] === 'outOfService') {
                    $results['skipped'][] = ['game_id' => $gameId, 'game_name' => $cached['game_name'], 'reason' => 'outOfService'];
                    self::logAction($source, 'skip', $groupId, $gameId, $cached['game_name'], true, null, ['reason' => 'outOfService']);
                    continue;
                }

                // Skip if already in desired state
                if ($cached['operation_status'] === $desiredStatus) {
                    $results['skipped'][] = ['game_id' => $gameId, 'game_name' => $cached['game_name'], 'reason' => 'already_' . $desiredStatus];
                    continue;
                }

                $changes[$gameId] = $desiredStatus;
            }

            if (empty($changes)) {
                return $results;
            }

            // Patch games via CenterEdge API
            $patchResult = $client->patchGames($changes);

            // Process successes
            foreach ($patchResult['games'] ?? [] as $game) {
                $gid = (string)$game['id'];
                $gname = $game['name'] ?? '';
                $results['changed'][] = ['game_id' => $gid, 'game_name' => $gname, 'new_status' => $desiredStatus];

                // Update cache
                DB::execute(
                    'UPDATE game_state_cache SET operation_status = :p0, last_synced_at = datetime(\'now\') WHERE game_id = :p1',
                    [$game['operationStatus'] ?? $desiredStatus, $gid]
                );

                $actionName = $desiredStatus === 'paused' ? 'pause' : 'unpause';
                self::logAction($source, $actionName, $groupId, $gid, $gname, true);
            }

            // Process errors
            foreach ($patchResult['errors'] ?? [] as $gid => $error) {
                $gname = '';
                $cached = DB::queryOne('SELECT game_name FROM game_state_cache WHERE game_id = :p0', [(string)$gid]);
                if ($cached) $gname = $cached['game_name'];

                $errorMsg = $error['message'] ?? 'Unknown error';
                $results['errors'][] = ['game_id' => (string)$gid, 'game_name' => $gname, 'error' => $errorMsg];

                $actionName = $desiredStatus === 'paused' ? 'pause' : 'unpause';
                self::logAction($source, $actionName, $groupId, (string)$gid, $gname, false, $errorMsg);
            }
        } catch (Exception $e) {
            $actionName = $desiredStatus === 'paused' ? 'pause' : 'unpause';
            self::logAction($source, $actionName, $groupId, '', '', false, $e->getMessage());
            $results['errors'][] = ['error' => $e->getMessage()];
        }

        return $results;
    }

    /**
     * Resolve a pause group to a list of unique game IDs.
     * Combines category-based and individual game membership.
     */
    public static function resolveGroupGames(int $groupId): array {
        $gameIds = [];

        // Get categories linked to this group
        $categories = DB::query(
            'SELECT category_id FROM pause_group_categories WHERE pause_group_id = :p0',
            [$groupId]
        );
        $catIds = array_column($categories, 'category_id');

        // Find games belonging to those categories from cache
        if (!empty($catIds)) {
            $allCached = DB::query('SELECT game_id, categories FROM game_state_cache');
            foreach ($allCached as $row) {
                $gameCats = json_decode($row['categories'], true) ?: [];
                foreach ($catIds as $catId) {
                    if (in_array((int)$catId, $gameCats)) {
                        $gameIds[$row['game_id']] = true;
                        break;
                    }
                }
            }
        }

        // Get individually linked games
        $individualGames = DB::query(
            'SELECT game_id FROM pause_group_games WHERE pause_group_id = :p0',
            [$groupId]
        );
        foreach ($individualGames as $row) {
            $gameIds[$row['game_id']] = true;
        }

        return array_keys($gameIds);
    }

    /**
     * Sync game states from CenterEdge to cache.
     */
    public static function syncGameStates(): int {
        $client = new CenterEdgeClient();
        return $client->syncGamesToCache();
    }

    /**
     * Check for and execute missed actions (earlier today, not yet executed).
     */
    public static function executeMissedActions(?string $date = null): void {
        $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
        date_default_timezone_set($tz);

        if ($date === null) {
            $date = date('Y-m-d');
        }

        $now = new DateTime('now', new DateTimeZone($tz));
        $nowTime = $now->format('H:i');

        $missed = DB::query(
            'SELECT id FROM scheduled_actions
             WHERE scheduled_date = :p0 AND executed = 0 AND scheduled_time <= :p1
             ORDER BY scheduled_time ASC',
            [$date, $nowTime]
        );

        foreach ($missed as $action) {
            try {
                self::executeAction($action['id']);
            } catch (Exception $e) {
                error_log("Failed to execute missed action #{$action['id']}: " . $e->getMessage());
            }
        }
    }

    // -----------------------------------------------
    // At Job Management
    // -----------------------------------------------

    /**
     * Parse at job ID from at command output.
     * at outputs: "job 42 at Mon Feb 24 09:00:00 2026"
     */
    private static function parseAtJobId(string $output): ?string {
        if (preg_match('/job\s+(\d+)\s+at/', $output, $matches)) {
            return $matches[1];
        }
        return null;
    }

    /**
     * Cancel an at job by ID.
     */
    private static function cancelAtJob(string $jobId): bool {
        $output = [];
        exec('atrm ' . escapeshellarg($jobId) . ' 2>&1', $output, $exitCode);
        return $exitCode === 0;
    }

    // -----------------------------------------------
    // Logging
    // -----------------------------------------------

    /**
     * Log an action to the action_log table.
     */
    private static function logAction(
        string $source,
        string $action,
        int $groupId,
        string $gameId,
        string $gameName,
        bool $success,
        ?string $errorMessage = null,
        ?array $details = null
    ): void {
        DB::execute(
            'INSERT INTO action_log (source, action, pause_group_id, game_id, game_name, success, error_message, details)
             VALUES (:p0, :p1, :p2, :p3, :p4, :p5, :p6, :p7)',
            [
                $source,
                $action,
                $groupId,
                $gameId,
                $gameName,
                $success ? 1 : 0,
                $errorMessage,
                $details ? json_encode($details) : null,
            ]
        );
    }
}

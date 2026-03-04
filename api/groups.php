<?php
/**
 * API: Pause group CRUD + manual actions.
 * GET    /api/groups              — List all groups with member counts and current state
 * GET    /api/groups/{id}         — Single group with categories + games
 * POST   /api/groups              — Create group
 * POST   /api/groups/{id}/pause   — Immediately pause all games in group
 * POST   /api/groups/{id}/unpause — Immediately unpause all games in group
 * PUT    /api/groups/{id}         — Update group
 * DELETE /api/groups/{id}         — Delete group
 */

require_once __DIR__ . '/../lib/validator.php';

function handleGroups(string $method, array $parts, ?array $input): void {
    Auth::requireAuth();

    $groupId = isset($parts[0]) && is_numeric($parts[0]) ? (int)$parts[0] : null;
    $action = $parts[1] ?? null;

    // Handle POST /api/groups/{id}/pause or /unpause
    if ($method === 'POST' && $groupId && in_array($action, ['pause', 'unpause'], true)) {
        manualGroupAction($groupId, $action);
        return;
    }

    switch ($method) {
        case 'GET':
            if ($groupId) {
                getGroup($groupId);
            } else {
                listGroups();
            }
            break;
        case 'POST':
            createGroup($input);
            break;
        case 'PUT':
            if (!$groupId) {
                http_response_code(400);
                echo json_encode(['error' => 'Group ID required']);
                return;
            }
            updateGroup($groupId, $input);
            break;
        case 'DELETE':
            if (!$groupId) {
                http_response_code(400);
                echo json_encode(['error' => 'Group ID required']);
                return;
            }
            deleteGroup($groupId);
            break;
        default:
            http_response_code(405);
            echo json_encode(['error' => 'Method not allowed']);
    }
}

function listGroups(): void {
    $groups = DB::query(
        'SELECT g.id, g.name, g.description, g.is_active, g.created_at, g.updated_at,
                (SELECT COUNT(*) FROM pause_group_categories WHERE pause_group_id = g.id) as category_count,
                (SELECT COUNT(*) FROM pause_group_games WHERE pause_group_id = g.id) as game_count,
                (SELECT COUNT(*) FROM schedules WHERE pause_group_id = g.id AND is_active = 1) as schedule_count
         FROM pause_groups g
         ORDER BY g.name ASC'
    );

    // Enrich each group with live state, schedule context, and override info
    require_once __DIR__ . '/../lib/centeredge_client.php';
    require_once __DIR__ . '/../lib/scheduler.php';

    $tz = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
    date_default_timezone_set($tz);
    $now = new DateTime();
    $todayDow = (int)$now->format('w');
    $currentTime = $now->format('H:i:s');
    $currentDatetime = $now->format('Y-m-d H:i:s');

    foreach ($groups as &$group) {
        $gid = (int)$group['id'];

        // Game stats from cache
        $gameIds = Scheduler::resolveGroupGames($gid);
        $enabledCount = 0;
        $pausedCount = 0;
        $oosCount = 0;
        foreach ($gameIds as $gameId) {
            $cached = DB::queryOne('SELECT operation_status FROM game_state_cache WHERE game_id = :p0', [$gameId]);
            if (!$cached) continue;
            if ($cached['operation_status'] === 'enabled') $enabledCount++;
            elseif ($cached['operation_status'] === 'paused') $pausedCount++;
            elseif ($cached['operation_status'] === 'outOfService') $oosCount++;
        }
        $total = $enabledCount + $pausedCount + $oosCount;
        $group['effective_state'] = $total === 0 ? 'empty'
            : ($pausedCount > 0 && $enabledCount === 0 ? 'paused'
            : ($enabledCount > 0 && $pausedCount === 0 ? 'enabled' : 'mixed'));
        $group['game_stats'] = [
            'total' => $total,
            'enabled' => $enabledCount,
            'paused' => $pausedCount,
            'out_of_service' => $oosCount,
        ];

        // Next scheduled transition today
        $nextTransition = null;
        if ($group['is_active']) {
            $todaySchedules = DB::query(
                'SELECT start_time, end_time FROM schedules
                 WHERE pause_group_id = :p0 AND day_of_week = :p1 AND is_active = 1
                 ORDER BY start_time ASC',
                [$gid, $todayDow]
            );
            foreach ($todaySchedules as $sched) {
                if ($sched['start_time'] > $currentTime) {
                    $nextTransition = ['time' => $sched['start_time'], 'action' => 'pause'];
                    break;
                }
                if ($sched['end_time'] > $currentTime) {
                    $nextTransition = ['time' => $sched['end_time'], 'action' => 'unpause'];
                    break;
                }
            }
        }
        $group['next_transition'] = $nextTransition;

        // Active override
        $activeOverride = null;
        if ($group['is_active']) {
            $activeOverride = DB::queryOne(
                'SELECT name, action, end_datetime FROM schedule_overrides
                 WHERE pause_group_id = :p0 AND start_datetime <= :p1 AND end_datetime >= :p1
                 ORDER BY end_datetime DESC LIMIT 1',
                [$gid, $currentDatetime]
            );
        }
        $group['active_override'] = $activeOverride ?: null;
    }
    unset($group);

    echo json_encode(['groups' => $groups]);
}

/**
 * Immediately pause or unpause all games in a group.
 */
function manualGroupAction(int $groupId, string $action): void {
    $group = DB::queryOne('SELECT id, name, is_active FROM pause_groups WHERE id = :p0', [$groupId]);
    if (!$group) {
        http_response_code(404);
        echo json_encode(['error' => 'Group not found']);
        return;
    }

    require_once __DIR__ . '/../lib/centeredge_client.php';
    require_once __DIR__ . '/../lib/scheduler.php';

    $results = Scheduler::executeImmediate($groupId, $action, 'manual');

    echo json_encode([
        'success' => empty($results['errors']),
        'action'  => $action,
        'group_id' => $groupId,
        'group_name' => $group['name'],
        'changed' => count($results['changed']),
        'skipped' => count($results['skipped']),
        'errors'  => count($results['errors']),
        'details' => $results,
    ]);
}

function getGroup(int $groupId): void {
    $group = DB::queryOne('SELECT * FROM pause_groups WHERE id = :p0', [$groupId]);
    if (!$group) {
        http_response_code(404);
        echo json_encode(['error' => 'Group not found']);
        return;
    }

    $group['categories'] = DB::query(
        'SELECT id, category_id, category_name FROM pause_group_categories WHERE pause_group_id = :p0',
        [$groupId]
    );
    $group['games'] = DB::query(
        'SELECT id, game_id, game_name FROM pause_group_games WHERE pause_group_id = :p0',
        [$groupId]
    );
    $group['schedules'] = DB::query(
        'SELECT * FROM schedules WHERE pause_group_id = :p0 ORDER BY day_of_week, start_time',
        [$groupId]
    );

    echo json_encode($group);
}

function createGroup(?array $input): void {
    if (!$input) {
        http_response_code(400);
        echo json_encode(['error' => 'Request body required']);
        return;
    }

    $name = Validator::requireString($input, 'name');
    $description = Validator::optionalString($input, 'description');
    $isActive = (int)($input['is_active'] ?? 1);
    $categoryIds = Validator::optionalIntArray($input, 'category_ids');
    $gameIds = Validator::optionalStringArray($input, 'game_ids');

    $db = DB::getInstance();
    $db->exec('BEGIN TRANSACTION');

    try {
        DB::execute(
            'INSERT INTO pause_groups (name, description, is_active) VALUES (:p0, :p1, :p2)',
            [$name, $description, $isActive]
        );
        $groupId = DB::lastInsertId();

        // Insert category links
        foreach ($categoryIds as $catId) {
            $catName = getCategoryName($catId);
            DB::execute(
                'INSERT INTO pause_group_categories (pause_group_id, category_id, category_name) VALUES (:p0, :p1, :p2)',
                [$groupId, $catId, $catName]
            );
        }

        // Insert individual game links
        foreach ($gameIds as $gameId) {
            $gameName = getGameName($gameId);
            DB::execute(
                'INSERT INTO pause_group_games (pause_group_id, game_id, game_name) VALUES (:p0, :p1, :p2)',
                [$groupId, $gameId, $gameName]
            );
        }

        $db->exec('COMMIT');

        http_response_code(201);
        getGroup($groupId);
    } catch (Exception $e) {
        $db->exec('ROLLBACK');
        throw $e;
    }
}

function updateGroup(int $groupId, ?array $input): void {
    if (!$input) {
        http_response_code(400);
        echo json_encode(['error' => 'Request body required']);
        return;
    }

    $existing = DB::queryOne('SELECT id FROM pause_groups WHERE id = :p0', [$groupId]);
    if (!$existing) {
        http_response_code(404);
        echo json_encode(['error' => 'Group not found']);
        return;
    }

    $name = Validator::requireString($input, 'name');
    $description = Validator::optionalString($input, 'description');
    $isActive = (int)($input['is_active'] ?? 1);
    $categoryIds = Validator::optionalIntArray($input, 'category_ids');
    $gameIds = Validator::optionalStringArray($input, 'game_ids');

    $db = DB::getInstance();
    $db->exec('BEGIN TRANSACTION');

    try {
        DB::execute(
            'UPDATE pause_groups SET name = :p0, description = :p1, is_active = :p2, updated_at = datetime(\'now\') WHERE id = :p3',
            [$name, $description, $isActive, $groupId]
        );

        // Replace category links
        DB::execute('DELETE FROM pause_group_categories WHERE pause_group_id = :p0', [$groupId]);
        foreach ($categoryIds as $catId) {
            $catName = getCategoryName($catId);
            DB::execute(
                'INSERT INTO pause_group_categories (pause_group_id, category_id, category_name) VALUES (:p0, :p1, :p2)',
                [$groupId, $catId, $catName]
            );
        }

        // Replace individual game links
        DB::execute('DELETE FROM pause_group_games WHERE pause_group_id = :p0', [$groupId]);
        foreach ($gameIds as $gameId) {
            $gameName = getGameName($gameId);
            DB::execute(
                'INSERT INTO pause_group_games (pause_group_id, game_id, game_name) VALUES (:p0, :p1, :p2)',
                [$groupId, $gameId, $gameName]
            );
        }

        $db->exec('COMMIT');
        getGroup($groupId);
    } catch (Exception $e) {
        $db->exec('ROLLBACK');
        throw $e;
    }
}

function deleteGroup(int $groupId): void {
    $existing = DB::queryOne('SELECT id FROM pause_groups WHERE id = :p0', [$groupId]);
    if (!$existing) {
        http_response_code(404);
        echo json_encode(['error' => 'Group not found']);
        return;
    }

    DB::execute('DELETE FROM pause_groups WHERE id = :p0', [$groupId]);
    echo json_encode(['success' => true]);
}

/**
 * Look up a category name from the game_state_cache or return a default.
 */
function getCategoryName(int $categoryId): string {
    // Try to find from any game that belongs to this category
    $rows = DB::query(
        'SELECT categories FROM game_state_cache LIMIT 500'
    );
    foreach ($rows as $row) {
        $cats = json_decode($row['categories'], true) ?: [];
        if (in_array($categoryId, $cats)) {
            return "Category $categoryId";
        }
    }
    return "Category $categoryId";
}

/**
 * Look up a game name from the game_state_cache.
 */
function getGameName(string $gameId): string {
    $row = DB::queryOne('SELECT game_name FROM game_state_cache WHERE game_id = :p0', [$gameId]);
    return $row ? $row['game_name'] : "Game $gameId";
}

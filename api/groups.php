<?php
/**
 * API: Pause group CRUD.
 * GET    /api/groups        — List all groups with member counts
 * GET    /api/groups/{id}   — Single group with categories + games
 * POST   /api/groups        — Create group
 * PUT    /api/groups/{id}   — Update group
 * DELETE /api/groups/{id}   — Delete group
 */

require_once __DIR__ . '/../lib/validator.php';

function handleGroups(string $method, array $parts, ?array $input): void {
    Auth::requireAuth();

    $groupId = isset($parts[0]) && is_numeric($parts[0]) ? (int)$parts[0] : null;

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
    echo json_encode(['groups' => $groups]);
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

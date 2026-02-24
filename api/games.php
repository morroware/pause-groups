<?php
/**
 * API: Proxy game and category data from CenterEdge.
 * GET /api/games — Return games from cache (or auto-sync if empty)
 * GET /api/games/categories — Return categories from CenterEdge
 * POST /api/games/sync — Force sync game states from CenterEdge
 */

require_once __DIR__ . '/../lib/centeredge_client.php';

function handleGames(string $method, array $parts, ?array $input): void {
    Auth::requireAuth();

    $action = $parts[0] ?? '';

    if ($method === 'GET' && $action === '') {
        // Return games from cache
        $cached = DB::query(
            'SELECT game_id, game_name, operation_status, categories, last_synced_at
             FROM game_state_cache ORDER BY game_name ASC'
        );

        // Auto-sync if cache is empty
        if (empty($cached)) {
            try {
                $client = new CenterEdgeClient();
                if ($client->isConfigured()) {
                    $client->syncGamesToCache();
                    $cached = DB::query(
                        'SELECT game_id, game_name, operation_status, categories, last_synced_at
                         FROM game_state_cache ORDER BY game_name ASC'
                    );
                }
            } catch (Exception $e) {
                // Ignore sync errors, return empty
            }
        }

        // Parse categories JSON for each game
        $games = array_map(function ($g) {
            $g['categories'] = json_decode($g['categories'], true) ?: [];
            return $g;
        }, $cached);

        // Get last sync time
        $lastSync = DB::queryOne('SELECT MAX(last_synced_at) as last_synced FROM game_state_cache');

        echo json_encode([
            'games'       => $games,
            'total'       => count($games),
            'last_synced' => $lastSync['last_synced'] ?? null,
        ]);
        return;
    }

    if ($method === 'GET' && $action === 'categories') {
        // Fetch categories from CenterEdge (always live)
        $client = new CenterEdgeClient();
        $categories = $client->getCategories();
        echo json_encode(['categories' => $categories]);
        return;
    }

    if ($method === 'POST' && $action === 'sync') {
        // Force sync
        $client = new CenterEdgeClient();
        $count = $client->syncGamesToCache();

        echo json_encode([
            'success'    => true,
            'game_count' => $count,
            'synced_at'  => gmdate('Y-m-d H:i:s'),
        ]);
        return;
    }

    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
}

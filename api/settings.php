<?php
/**
 * API: CenterEdge API configuration management.
 * GET /api/settings — Return current config (passwords masked)
 * PUT /api/settings — Update config
 * POST /api/settings/test — Test CenterEdge connection
 */

require_once __DIR__ . '/../lib/centeredge_client.php';
require_once __DIR__ . '/../lib/validator.php';

function handleSettings(string $method, array $parts, ?array $input): void {
    Auth::requireAuth();

    $action = $parts[0] ?? '';

    if ($method === 'GET' && $action === '') {
        // Return current config (passwords masked)
        $baseUrl  = DB::getConfig('base_url') ?? '';
        $username = DB::getConfig('username') ?? '';
        $password = DB::getConfig('password');
        $apiKey   = DB::getConfig('api_key');
        $timezone = DB::getConfig('timezone') ?? DEFAULT_TIMEZONE;
        $tokenFetchedAt = DB::getConfig('token_fetched_at');

        echo json_encode([
            'base_url'          => $baseUrl,
            'username'          => $username,
            'password'          => $password ? '********' : '',
            'api_key'           => $apiKey ? '********' : '',
            'timezone'          => $timezone,
            'token_fetched_at'  => $tokenFetchedAt,
        ]);
        return;
    }

    if ($method === 'PUT' && $action === '') {
        // Update settings
        $baseUrl  = Validator::requireUrl($input, 'base_url');
        $username = Validator::requireString($input, 'username');
        $password = $input['password'] ?? '';
        $apiKey   = $input['api_key'] ?? '';
        $timezone = Validator::requireString($input, 'timezone', 100);

        // Validate timezone
        try {
            new DateTimeZone($timezone);
        } catch (Exception $e) {
            throw new RuntimeException("Invalid timezone: $timezone");
        }

        DB::setConfig('base_url', $baseUrl, false);
        DB::setConfig('username', $username, true);
        DB::setConfig('timezone', $timezone, false);

        // Only update password if not the masked placeholder
        if ($password !== '' && $password !== '********') {
            DB::setConfig('password', $password, true);
            // Clear cached token when credentials change
            DB::setConfig('bearer_token', null, false);
            DB::setConfig('token_fetched_at', null, false);
        }

        // Only update api_key if not the masked placeholder
        if ($apiKey !== '********') {
            DB::setConfig('api_key', $apiKey ?: null, $apiKey ? true : false);
        }

        echo json_encode(['success' => true]);
        return;
    }

    if ($method === 'POST' && $action === 'test') {
        // Test connection
        $client = new CenterEdgeClient();
        $result = $client->testConnection();
        echo json_encode($result);
        return;
    }

    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
}

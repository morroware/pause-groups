<?php
/**
 * CenterEdge Card System API client.
 * Handles authentication (SHA-1 hash), token caching, and all game management endpoints.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/crypto.php';

class CenterEdgeClient {
    private ?string $baseUrl = null;
    private ?string $username = null;
    private ?string $password = null;
    private ?string $apiKey = null;
    private ?string $bearerToken = null;
    private ?string $tokenFetchedAt = null;

    public function __construct() {
        $this->loadConfig();
    }

    /**
     * Load API configuration from the database.
     */
    private function loadConfig(): void {
        $this->baseUrl = DB::getConfig('base_url');
        $this->username = DB::getConfig('username');
        $this->password = DB::getConfig('password');
        $this->apiKey = DB::getConfig('api_key');
        $this->bearerToken = DB::getConfig('bearer_token');
        $this->tokenFetchedAt = DB::getConfig('token_fetched_at');
    }

    /**
     * Check if the client is configured with API credentials.
     */
    public function isConfigured(): bool {
        return !empty($this->baseUrl) && !empty($this->username) && !empty($this->password);
    }

    // -----------------------------------------------
    // Authentication
    // -----------------------------------------------

    /**
     * Authenticate with CenterEdge using SHA-1 hash flow.
     * Returns the bearer token.
     */
    public function authenticate(): string {
        if (!$this->isConfigured()) {
            throw new RuntimeException('CenterEdge API is not configured. Please set up API credentials in Settings.');
        }

        // Generate timestamp in ISO 8601 UTC with milliseconds
        $dt = new DateTime('now', new DateTimeZone('UTC'));
        $requestTimestamp = $dt->format('Y-m-d\TH:i:s.v\Z');

        // Build the hash: SHA-1(username + password + requestTimestamp), then base64
        $concat = $this->username . $this->password . $requestTimestamp;
        $rawHash = sha1($concat, true);
        $passwordHash = base64_encode($rawHash);

        $body = [
            'username'         => $this->username,
            'passwordHash'     => $passwordHash,
            'requestTimestamp'  => $requestTimestamp,
        ];

        $result = $this->httpRequest('POST', '/login', $body, false);

        if (!isset($result['bearerToken'])) {
            throw new RuntimeException('CenterEdge login failed: no bearer token in response.');
        }

        $this->bearerToken = $result['bearerToken'];
        $this->tokenFetchedAt = gmdate('Y-m-d H:i:s');

        // Cache the token encrypted in the database
        DB::setConfig('bearer_token', $this->bearerToken, true);
        DB::setConfig('token_fetched_at', $this->tokenFetchedAt, false);

        return $this->bearerToken;
    }

    /**
     * Get a valid bearer token (reuses cached if fresh enough).
     */
    private function getToken(): string {
        if ($this->bearerToken && !$this->tokenNeedsRefresh()) {
            return $this->bearerToken;
        }
        return $this->authenticate();
    }

    /**
     * Check if the cached token needs refresh (older than TOKEN_MAX_AGE).
     */
    private function tokenNeedsRefresh(): bool {
        if (!$this->tokenFetchedAt) {
            return true;
        }
        $fetchedAt = strtotime($this->tokenFetchedAt . ' UTC');
        return (time() - $fetchedAt) > TOKEN_MAX_AGE;
    }

    // -----------------------------------------------
    // Game Endpoints
    // -----------------------------------------------

    /**
     * Fetch ALL games from CenterEdge (handles pagination).
     * Returns array of game objects.
     */
    public function getGames(): array {
        $allGames = [];
        $skip = 0;
        $take = GAMES_PAGE_SIZE;

        do {
            $result = $this->request('GET', '/games', null, ['skip' => $skip, 'take' => $take]);
            $games = $result['games'] ?? [];
            $allGames = array_merge($allGames, $games);
            $totalCount = $result['totalCount'] ?? null;
            $skip += count($games);

            // Stop if we got fewer than requested or reached totalCount
            if (count($games) < $take) {
                break;
            }
            if ($totalCount !== null && $skip >= $totalCount) {
                break;
            }
        } while (true);

        return $allGames;
    }

    /**
     * Fetch ALL game categories from CenterEdge.
     * Returns array of category objects.
     */
    public function getCategories(): array {
        $allCategories = [];
        $skip = 0;
        $take = GAMES_PAGE_SIZE;

        do {
            $result = $this->request('GET', '/games/categories', null, ['skip' => $skip, 'take' => $take]);
            $categories = $result['categories'] ?? [];
            $allCategories = array_merge($allCategories, $categories);
            $totalCount = $result['totalCount'] ?? null;
            $skip += count($categories);

            if (count($categories) < $take) {
                break;
            }
            if ($totalCount !== null && $skip >= $totalCount) {
                break;
            }
        } while (true);

        return $allCategories;
    }

    /**
     * Patch game operation statuses using JSON Patch format.
     * $changes = ['gameId' => 'paused', 'gameId2' => 'enabled', ...]
     * Returns ['games' => [...], 'errors' => [...]]
     */
    public function patchGames(array $changes): array {
        if (empty($changes)) {
            return ['games' => [], 'errors' => []];
        }

        $gamesPayload = [];
        foreach ($changes as $gameId => $status) {
            $gamesPayload[(string)$gameId] = [
                ['op' => 'replace', 'path' => '/operationStatus', 'value' => $status]
            ];
        }

        return $this->request('PATCH', '/games', ['games' => $gamesPayload]);
    }

    /**
     * Get API capabilities.
     */
    public function getCapabilities(): array {
        return $this->request('GET', '/capabilities');
    }

    /**
     * Test the connection: authenticate, check capabilities, count games.
     * Returns status array.
     */
    public function testConnection(): array {
        try {
            $this->authenticate();
            $capabilities = $this->getCapabilities();
            $games = $this->getGames();
            $categories = $this->getCategories();

            $supportsOperationStatus = $capabilities['games']['operationStatus'] ?? false;

            return [
                'success'                 => true,
                'system_name'             => $capabilities['systemName'] ?? 'Unknown',
                'interface_version'       => $capabilities['interfaceVersion'] ?? 'Unknown',
                'supports_operation_status' => $supportsOperationStatus,
                'supports_categories'     => $capabilities['games']['categories'] ?? false,
                'game_count'              => count($games),
                'category_count'          => count($categories),
                'error'                   => null,
            ];
        } catch (Exception $e) {
            return [
                'success'                 => false,
                'system_name'             => null,
                'interface_version'       => null,
                'supports_operation_status' => false,
                'supports_categories'     => false,
                'game_count'              => 0,
                'category_count'          => 0,
                'error'                   => $e->getMessage(),
            ];
        }
    }

    /**
     * Sync all games to the game_state_cache table.
     * Returns count of games synced.
     */
    public function syncGamesToCache(): int {
        $games = $this->getGames();

        foreach ($games as $game) {
            $gameId = (string)$game['id'];
            $gameName = $game['name'] ?? '';
            $opStatus = $game['operationStatus'] ?? 'enabled';
            $categories = json_encode($game['categories'] ?? []);

            DB::execute(
                'INSERT INTO game_state_cache (game_id, game_name, operation_status, categories, last_synced_at)
                 VALUES (:p0, :p1, :p2, :p3, datetime(\'now\'))
                 ON CONFLICT(game_id) DO UPDATE SET
                     game_name = :p1, operation_status = :p2, categories = :p3, last_synced_at = datetime(\'now\')',
                [$gameId, $gameName, $opStatus, $categories]
            );
        }

        return count($games);
    }

    // -----------------------------------------------
    // HTTP Layer
    // -----------------------------------------------

    /**
     * Make an authenticated API request with retry on 401.
     */
    private function request(string $method, string $path, ?array $body = null, array $query = []): array {
        $token = $this->getToken();

        try {
            return $this->httpRequest($method, $path, $body, true, $query);
        } catch (RuntimeException $e) {
            // If 401, re-authenticate and retry once
            if (strpos($e->getMessage(), '401') !== false) {
                $this->authenticate();
                return $this->httpRequest($method, $path, $body, true, $query);
            }
            throw $e;
        }
    }

    /**
     * Execute an HTTP request to the CenterEdge API.
     */
    private function httpRequest(string $method, string $path, ?array $body = null, bool $auth = true, array $query = []): array {
        $url = rtrim($this->baseUrl, '/') . $path;
        if (!empty($query)) {
            $url .= '?' . http_build_query($query);
        }

        $headers = [
            'Accept: application/json',
            'Content-Type: application/json',
        ];

        if ($auth && $this->bearerToken) {
            $headers[] = 'Authorization: Bearer ' . $this->bearerToken;
        }

        if ($this->apiKey) {
            $headers[] = 'X-Api-Key: ' . $this->apiKey;
        }

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => API_TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 3,
        ]);

        if ($method === 'POST') {
            curl_setopt($ch, CURLOPT_POST, true);
            if ($body !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
            }
        } elseif ($method === 'PATCH') {
            curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'PATCH');
            if ($body !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
            }
        } elseif ($method === 'PUT') {
            curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'PUT');
            if ($body !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
            }
        }

        $responseBody = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);

        if ($curlError) {
            throw new RuntimeException("CenterEdge API connection error: $curlError");
        }

        $data = json_decode($responseBody, true);

        if ($httpCode === 401) {
            throw new RuntimeException("CenterEdge API error: 401 Unauthorized");
        }

        if ($httpCode === 403) {
            $msg = $data['message'] ?? 'Forbidden';
            throw new RuntimeException("CenterEdge API error: 403 $msg");
        }

        if ($httpCode >= 400) {
            $msg = $data['message'] ?? ($data['error'] ?? "HTTP $httpCode");
            throw new RuntimeException("CenterEdge API error: $msg (HTTP $httpCode)");
        }

        return $data ?? [];
    }
}

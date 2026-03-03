<?php
/**
 * Main router: serves SPA shell for browser requests and dispatches API requests.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/crypto.php';
require_once __DIR__ . '/lib/csrf.php';
require_once __DIR__ . '/lib/auth.php';

// Start session for all requests
Auth::initSession();

// Parse the request
$requestUri = $_SERVER['REQUEST_URI'] ?? '/';
$scriptName = $_SERVER['SCRIPT_NAME'] ?? '';
$basePath = rtrim(dirname($scriptName), '/');

// Remove basePath prefix and query string
$path = $requestUri;
if ($basePath && strpos($path, $basePath) === 0) {
    $path = substr($path, strlen($basePath));
}
$path = strtok($path, '?');
$path = trim($path, '/');
$method = $_SERVER['REQUEST_METHOD'];

// Basic security headers for all responses
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');

// ---------------------------------------------------
// API Routes
// ---------------------------------------------------
if (strpos($path, 'api/') === 0) {
    header('Content-Type: application/json; charset=utf-8');

    // Safety net: execute any missed scheduled actions (at most once per minute).
    // This catches actions whose at-jobs failed silently.
    $missedCheckFile = __DIR__ . '/data/.last_missed_check';
    if (!file_exists($missedCheckFile) || (time() - filemtime($missedCheckFile)) >= 60) {
        @touch($missedCheckFile);
        try {
            require_once __DIR__ . '/lib/centeredge_client.php';
            require_once __DIR__ . '/lib/scheduler.php';
            Scheduler::executeMissedActions();
        } catch (Exception $e) {
            error_log('Missed-action check failed: ' . $e->getMessage());
        }
    }

    // CSRF validation for state-changing methods (exempt login endpoint)
    $isLogin = ($path === 'api/auth/login');
    if (!$isLogin && in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'])) {
        if (!CSRF::validate()) {
            http_response_code(403);
            echo json_encode(['error' => 'Invalid or missing CSRF token']);
            exit;
        }
    }

    // Parse API path: api/{resource}/{id?}/{action?}
    $apiPath = substr($path, 4); // Remove 'api/'
    $parts = array_values(array_filter(explode('/', $apiPath)));
    $resource = array_shift($parts) ?? '';

    // Parse JSON body for POST/PUT/PATCH
    $input = null;
    if (in_array($method, ['POST', 'PUT', 'PATCH'])) {
        $rawBody = file_get_contents('php://input');
        if ($rawBody !== '') {
            $input = json_decode($rawBody, true);
            if ($input === null && json_last_error() !== JSON_ERROR_NONE) {
                http_response_code(400);
                echo json_encode(['error' => 'Invalid JSON body']);
                exit;
            }
        }
    }

    // Dispatch to handler
    try {
        switch ($resource) {
            case 'auth':
                require_once __DIR__ . '/api/auth.php';
                handleAuth($method, $parts, $input);
                break;
            case 'settings':
                require_once __DIR__ . '/api/settings.php';
                handleSettings($method, $parts, $input);
                break;
            case 'games':
                require_once __DIR__ . '/api/games.php';
                handleGames($method, $parts, $input);
                break;
            case 'groups':
                require_once __DIR__ . '/api/groups.php';
                handleGroups($method, $parts, $input);
                break;
            case 'schedules':
                require_once __DIR__ . '/api/schedules.php';
                handleSchedules($method, $parts, $input);
                break;
            case 'overrides':
                require_once __DIR__ . '/api/overrides.php';
                handleOverrides($method, $parts, $input);
                break;
            case 'logs':
                require_once __DIR__ . '/api/logs.php';
                handleLogs($method, $parts, $input);
                break;
            case 'users':
                require_once __DIR__ . '/api/users.php';
                handleUsers($method, $parts, $input);
                break;
            default:
                http_response_code(404);
                echo json_encode(['error' => 'Unknown API endpoint']);
        }
    } catch (RuntimeException $e) {
        http_response_code(422);
        echo json_encode(['error' => $e->getMessage()]);
    } catch (Exception $e) {
        http_response_code(500);
        $msg = $e->getMessage();
        // Surface actionable details for common setup issues
        if (stripos($msg, 'unable to open database') !== false || stripos($msg, 'readonly') !== false) {
            $hint = 'Database error: ' . $msg . '. Check that the data/ directory and .db file are writable by the web server (e.g. sudo chown -R www-data:www-data data/).';
            echo json_encode(['error' => $hint]);
        } else {
            $publicMessage = APP_DEBUG
                ? 'Internal server error: ' . $msg
                : 'Internal server error';
            echo json_encode(['error' => $publicMessage]);
        }
        error_log('Unhandled exception: ' . $msg . "\n" . $e->getTraceAsString());
    }
    exit;
}

// ---------------------------------------------------
// Static file serving (CSS, JS)
// ---------------------------------------------------
if (strpos($path, 'public/') === 0) {
    $publicRoot = realpath(__DIR__ . '/public');
    $filePath = realpath(__DIR__ . '/' . $path);

    if ($publicRoot && $filePath && is_file($filePath) && strpos($filePath, $publicRoot . DIRECTORY_SEPARATOR) === 0) {
        $ext = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
        $mimeTypes = [
            'css'  => 'text/css',
            'js'   => 'application/javascript',
            'png'  => 'image/png',
            'jpg'  => 'image/jpeg',
            'svg'  => 'image/svg+xml',
            'ico'  => 'image/x-icon',
            'woff' => 'font/woff',
            'woff2'=> 'font/woff2',
        ];
        header('Content-Type: ' . ($mimeTypes[$ext] ?? 'application/octet-stream'));
        header('Cache-Control: public, max-age=3600');
        readfile($filePath);
        exit;
    }
}

// ---------------------------------------------------
// SPA Shell — serves for all other routes
// ---------------------------------------------------
$csrfToken = CSRF::getToken();
if (!$csrfToken) {
    $csrfToken = CSRF::generate();
}
$user = Auth::check();
$userJson = $user ? json_encode($user) : 'null';
$csrfJson = json_encode($csrfToken);
$basePathJson = json_encode($basePath);

?><!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pause Group Automation</title>
    <link rel="icon" href="data:,">
    <meta name="csrf-token" content="<?= htmlspecialchars($csrfToken) ?>">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="<?= htmlspecialchars($basePath) ?>/public/css/style.css">
</head>
<body>
    <div id="app"></div>

    <script>
        window.APP_CONFIG = {
            basePath: <?= $basePathJson ?>,
            csrfToken: <?= $csrfJson ?>,
            user: <?= $userJson ?>
        };
    </script>
    <script src="<?= htmlspecialchars($basePath) ?>/public/js/api.js"></script>
    <script src="<?= htmlspecialchars($basePath) ?>/public/js/app.js"></script>
    <script src="<?= htmlspecialchars($basePath) ?>/public/js/login.js"></script>
    <script src="<?= htmlspecialchars($basePath) ?>/public/js/dashboard.js"></script>
    <script src="<?= htmlspecialchars($basePath) ?>/public/js/groups.js"></script>
    <script src="<?= htmlspecialchars($basePath) ?>/public/js/schedules.js"></script>
    <script src="<?= htmlspecialchars($basePath) ?>/public/js/overrides.js"></script>
    <script src="<?= htmlspecialchars($basePath) ?>/public/js/logs.js"></script>
    <script src="<?= htmlspecialchars($basePath) ?>/public/js/settings.js"></script>
</body>
</html>

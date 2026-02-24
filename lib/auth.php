<?php
/**
 * Admin session management: login, logout, session check.
 * Uses HttpOnly + SameSite=Strict cookies, bcrypt passwords, 2-hour timeout.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/csrf.php';

class Auth {
    /**
     * Configure and start the session with secure settings.
     */
    public static function initSession(): void {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }

        $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
        $cookiePath = (defined('BASE_PATH') && BASE_PATH !== '') ? rtrim(BASE_PATH, '/') . '/' : '/';
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => $cookiePath,
            'domain'   => '',
            'secure'   => $secure,
            'httponly'  => true,
            'samesite' => 'Strict',
        ]);

        ini_set('session.use_strict_mode', '1');
        ini_set('session.cookie_httponly', '1');
        ini_set('session.cookie_samesite', 'Strict');

        session_start();
    }

    /**
     * Attempt login with username and password.
     * Returns user array on success, null on failure.
     */
    public static function login(string $username, string $password): ?array {
        $user = DB::queryOne(
            'SELECT id, username, password_hash, display_name, is_active FROM admin_users WHERE username = :p0',
            [$username]
        );

        if (!$user || !$user['is_active']) {
            sleep(1); // Brute force protection
            return null;
        }

        if (!password_verify($password, $user['password_hash'])) {
            sleep(1);
            return null;
        }

        // Rehash if bcrypt cost has changed
        if (password_needs_rehash($user['password_hash'], PASSWORD_BCRYPT)) {
            $newHash = password_hash($password, PASSWORD_BCRYPT);
            DB::execute(
                'UPDATE admin_users SET password_hash = :p0, updated_at = datetime(\'now\') WHERE id = :p1',
                [$newHash, $user['id']]
            );
        }

        // Regenerate session ID to prevent fixation
        session_regenerate_id(true);

        // Store auth data in session
        $_SESSION['auth_user'] = [
            'id'           => $user['id'],
            'username'     => $user['username'],
            'display_name' => $user['display_name'],
        ];
        $_SESSION['auth_time'] = time();

        // Generate fresh CSRF token
        CSRF::generate();

        return $_SESSION['auth_user'];
    }

    /**
     * Destroy session and logout.
     */
    public static function logout(): void {
        $_SESSION = [];

        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000,
                $params['path'], $params['domain'],
                $params['secure'], $params['httponly']
            );
        }

        session_destroy();
    }

    /**
     * Check if the current session is authenticated and not expired.
     * Returns user array or null.
     */
    public static function check(): ?array {
        if (!isset($_SESSION['auth_user']) || !isset($_SESSION['auth_time'])) {
            return null;
        }

        // Check session timeout
        if ((time() - $_SESSION['auth_time']) > SESSION_LIFETIME) {
            self::logout();
            return null;
        }

        // Refresh last activity time
        $_SESSION['auth_time'] = time();

        return $_SESSION['auth_user'];
    }

    /**
     * Require authentication. Sends 401 JSON response and exits if not authenticated.
     * Returns user array on success.
     */
    public static function requireAuth(): array {
        $user = self::check();
        if ($user === null) {
            http_response_code(401);
            echo json_encode(['error' => 'Authentication required']);
            exit;
        }
        return $user;
    }

    /**
     * Get the current user's ID, or null if not authenticated.
     */
    public static function userId(): ?int {
        $user = self::check();
        return $user ? $user['id'] : null;
    }

    /**
     * Hash a password for storage using bcrypt.
     */
    public static function hashPassword(string $password): string {
        return password_hash($password, PASSWORD_BCRYPT);
    }
}

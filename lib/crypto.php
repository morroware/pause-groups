<?php
/**
 * AES-256-CBC encryption/decryption for credentials at rest.
 */

require_once __DIR__ . '/../config.php';

class Crypto {
    private static string $cipher = 'aes-256-cbc';

    /**
     * Encrypt plaintext using AES-256-CBC.
     * Returns base64(iv + ciphertext).
     */
    public static function encrypt(string $plaintext): string {
        $key = self::getKey();
        $ivLen = openssl_cipher_iv_length(self::$cipher);
        $iv = openssl_random_pseudo_bytes($ivLen);
        $ciphertext = openssl_encrypt($plaintext, self::$cipher, $key, OPENSSL_RAW_DATA, $iv);
        if ($ciphertext === false) {
            throw new RuntimeException('Encryption failed');
        }
        return base64_encode($iv . $ciphertext);
    }

    /**
     * Decrypt a value previously encrypted with encrypt().
     * Returns plaintext.
     */
    public static function decrypt(string $encrypted): string {
        $key = self::getKey();
        $data = base64_decode($encrypted, true);
        if ($data === false) {
            throw new RuntimeException('Decryption failed: invalid base64');
        }
        $ivLen = openssl_cipher_iv_length(self::$cipher);
        if (strlen($data) < $ivLen) {
            throw new RuntimeException('Decryption failed: data too short');
        }
        $iv = substr($data, 0, $ivLen);
        $ciphertext = substr($data, $ivLen);
        $plaintext = openssl_decrypt($ciphertext, self::$cipher, $key, OPENSSL_RAW_DATA, $iv);
        if ($plaintext === false) {
            throw new RuntimeException('Decryption failed: wrong key or corrupted data');
        }
        return $plaintext;
    }

    /**
     * Derive binary key from the hex ENCRYPTION_KEY constant.
     */
    private static function getKey(): string {
        $hexKey = ENCRYPTION_KEY;
        if (empty($hexKey)) {
            throw new RuntimeException('ENCRYPTION_KEY is not configured. Run install.php or set PG_ENCRYPTION_KEY env var.');
        }
        $key = hex2bin($hexKey);
        if ($key === false || strlen($key) < 16) {
            throw new RuntimeException('ENCRYPTION_KEY must be a valid hex string of at least 32 hex characters (16 bytes).');
        }
        // Pad or truncate to 32 bytes for AES-256
        if (strlen($key) < 32) {
            $key = hash('sha256', $key, true);
        } else {
            $key = substr($key, 0, 32);
        }
        return $key;
    }
}

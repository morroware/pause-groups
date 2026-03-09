# Deploying pause-groups beside Grafana on FCOS (`/ceplay` + subdomain)

This runbook is for your exact scenario:

- Fedora CoreOS VM already running Nginx reverse proxies
- Grafana already available at `http(s)://SERVER_IP/`
- You want pause-groups at `http(s)://SERVER_IP/ceplay` without breaking existing routes
- You also want `https://ceplay.thecastlefuncenter.com`

> Keep your existing `server {}` blocks. Do **not** replace them. Add only the `location` blocks shown below.

## 1) Install app files and PHP-FPM service

Follow `INSTALL-FCOS.md` through setup script execution, but **do not** add the generated standalone `server {}` block.

```bash
cd /var/persist
sudo git clone https://github.com/morroware/pause-groups.git pause-groups-src
cd /var/persist/pause-groups-src
sudo bash setup-fcos.sh
```

Expected runtime endpoints after script:

- App files: `/var/persist/pause-groups/`
- PHP-FPM listener: `127.0.0.1:9000`
- systemd service: `pause-groups-fpm`

## 2) Mount the app under `/ceplay` in your existing Nginx server block

Open your active Nginx config (`/var/persist/nginx.conf`) and add the following inside the **same** `server {}` block that currently serves `SERVER_IP`.

```nginx
# --- pause-groups at /ceplay ---
location = /ceplay {
    return 302 /ceplay/;
}

# Block direct access to sensitive paths
location ~ ^/ceplay/(data|lib|\.env|config\.php|cron.*\.php|run_action\.php|fresh_install\.php|AUDIT\.md|README\.md) {
    deny all;
    return 404;
}

# Static assets
location /ceplay/public/ {
    alias /var/persist/pause-groups/public/;
    expires 1h;
    add_header Cache-Control "public, immutable";
}

# Front controller: map /ceplay/* to index.php
location /ceplay/ {
    alias /var/persist/pause-groups/;
    try_files $uri $uri/ /ceplay/index.php?$query_string;
}

# PHP handling for /ceplay/*.php
location ~ ^/ceplay/(.+\.php)$ {
    alias /var/persist/pause-groups/$1;
    include fastcgi_params;
    fastcgi_pass 127.0.0.1:9000;
    fastcgi_index index.php;
    fastcgi_param SCRIPT_FILENAME /var/persist/pause-groups/$1;
    fastcgi_param REMOTE_ADDR $remote_addr;

    # Tell app it is mounted under /ceplay
    fastcgi_param SCRIPT_NAME /ceplay/$1;
    fastcgi_param REQUEST_URI $request_uri;
}
```

Why this is safe for Grafana/reverse proxies:

- It only matches `/ceplay` paths.
- Existing `/`, `/grafana`, and other proxy locations remain unchanged.
- No additional `listen` or `server_name` blocks are introduced, so no vhost precedence changes.

Then validate and reload:

```bash
sudo podman exec systemd-nginx nginx -t
sudo podman exec systemd-nginx nginx -s reload
```

## 3) Update app base URL assumptions

Because pause-groups is now under a subpath, set your external access URL to include `/ceplay` in user bookmarks and operational docs:

- `http://SERVER_IP/ceplay/`
- or `https://ceplay.thecastlefuncenter.com/` (after DNS + TLS below)

## 4) Verify nothing broke

Run these checks after reload:

```bash
# Existing root app (Grafana) should still respond
curl -I http://SERVER_IP/

# pause-groups health under subpath
curl -s http://SERVER_IP/ceplay/api/health

# Optional: verify Grafana path/proxy if you use one
curl -I http://SERVER_IP/grafana
```

If `/ceplay/api/health` returns JSON and Grafana still works, your coexistence config is correct.

## 5) DNS setup for `ceplay.thecastlefuncenter.com`

At your DNS provider:

1. Create an **A record**:
   - Name/Host: `ceplay`
   - Type: `A`
   - Value: your public server IP
   - TTL: 300 (or provider default)
2. If you already have an apex `A` record for `thecastlefuncenter.com`, this does **not** affect it.
3. Wait for propagation (usually a few minutes to 1 hour).

Check propagation:

```bash
dig +short ceplay.thecastlefuncenter.com A
```

## 6) TLS certificate for subdomain

Because this FCOS setup stores certs under `/var/persist/letsencrypt`, issue/renew a certificate that includes `ceplay.thecastlefuncenter.com` and point your Nginx TLS server block at those cert files.

Typical HTTPS server block pattern (adjust paths to your current cert layout):

```nginx
server {
    listen 443 ssl;
    server_name ceplay.thecastlefuncenter.com;

    ssl_certificate     /var/persist/letsencrypt/live/ceplay.thecastlefuncenter.com/fullchain.pem;
    ssl_certificate_key /var/persist/letsencrypt/live/ceplay.thecastlefuncenter.com/privkey.pem;

    # same /ceplay location blocks as above, or host directly at /
}
```

If your current Nginx container already terminates TLS for other sites, follow the same certificate automation method already in use there (do not introduce a second competing ACME flow).

## 7) Rollback plan (fast)

If anything goes wrong:

1. Remove only the `/ceplay` location blocks you added.
2. Re-test Nginx config.
3. Reload Nginx.

```bash
sudo podman exec systemd-nginx nginx -t
sudo podman exec systemd-nginx nginx -s reload
```

Grafana and existing proxies will return to prior behavior immediately.

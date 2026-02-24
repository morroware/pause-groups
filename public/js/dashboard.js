/**
 * Dashboard page: game status overview, stats, active schedules/overrides.
 */
(function() {
    App.registerRoute('#/dashboard', { render: renderDashboard });

    function renderDashboard(container) {
        let refreshInterval = null;

        container.appendChild(App.el('div', { className: 'page-header' }, [
            App.el('div', {}, [
                App.el('h1', { className: 'page-title', textContent: 'Dashboard' }),
                App.el('p', { className: 'page-subtitle', id: 'last-sync', textContent: 'Loading...' })
            ]),
            App.el('button', {
                className: 'btn btn-secondary', id: 'sync-btn', textContent: 'Sync Now',
                onClick: syncGames
            })
        ]));

        // Stats cards
        const statsGrid = App.el('div', { className: 'stats-grid', id: 'stats-grid' });
        container.appendChild(statsGrid);

        // Game grid
        container.appendChild(App.el('div', { className: 'card' }, [
            App.el('div', { className: 'card-header' }, [
                App.el('div', { className: 'card-title', textContent: 'Game Status' }),
                App.el('input', {
                    className: 'form-input', type: 'text', placeholder: 'Search games...',
                    id: 'game-search', style: { width: '200px', fontSize: '0.8rem', padding: '0.35rem 0.6rem' },
                    onInput: filterGames
                })
            ]),
            App.el('div', { className: 'game-grid', id: 'game-grid' })
        ]));

        // Active overrides section
        container.appendChild(App.el('div', { className: 'card mt-2', id: 'active-overrides-card' }, [
            App.el('div', { className: 'card-title', textContent: 'Active Overrides' }),
            App.el('div', { id: 'active-overrides', className: 'mt-1' })
        ]));

        loadDashboard();

        refreshInterval = setInterval(loadDashboard, 60000);

        return function cleanup() {
            if (refreshInterval) clearInterval(refreshInterval);
        };
    }

    let allGames = [];

    async function loadDashboard() {
        try {
            const [gamesData, overridesData] = await Promise.all([
                API.get('games'),
                API.get('overrides')
            ]);

            allGames = gamesData.games || [];
            renderStats(allGames);
            renderGameGrid(allGames);
            renderActiveOverrides(overridesData.active || []);

            const syncEl = document.getElementById('last-sync');
            if (syncEl) {
                syncEl.textContent = gamesData.last_synced
                    ? 'Last synced: ' + App.formatDatetime(gamesData.last_synced) + ' UTC'
                    : 'Not yet synced';
            }
        } catch (err) {
            App.toast(err.message, 'error');
        }
    }

    function renderStats(games) {
        const grid = document.getElementById('stats-grid');
        if (!grid) return;
        grid.innerHTML = '';

        const total = games.length;
        const enabled = games.filter(g => g.operation_status === 'enabled').length;
        const paused = games.filter(g => g.operation_status === 'paused').length;
        const oos = games.filter(g => g.operation_status === 'outOfService').length;

        const stats = [
            { label: 'Total Games', value: total, cls: '' },
            { label: 'Enabled', value: enabled, cls: 'text-success' },
            { label: 'Paused', value: paused, cls: 'text-warning' },
            { label: 'Out of Service', value: oos, cls: 'text-danger' },
        ];

        stats.forEach(s => {
            grid.appendChild(App.el('div', { className: 'stat-card' }, [
                App.el('div', { className: 'stat-label', textContent: s.label }),
                App.el('div', { className: 'stat-value ' + s.cls, textContent: String(s.value) })
            ]));
        });
    }

    function renderGameGrid(games) {
        const grid = document.getElementById('game-grid');
        if (!grid) return;
        grid.innerHTML = '';

        if (games.length === 0) {
            grid.appendChild(App.emptyState('\u{1F3AE}', 'No games found. Configure CenterEdge API in Settings.'));
            return;
        }

        const searchVal = (document.getElementById('game-search')?.value || '').toLowerCase();
        const filtered = searchVal ? games.filter(g => g.game_name.toLowerCase().includes(searchVal)) : games;

        filtered.forEach(game => {
            const tile = App.el('div', {
                className: 'game-tile',
                'data-status': game.operation_status
            }, [
                App.el('div', { className: 'game-tile-name', textContent: game.game_name }),
                App.el('div', { className: 'game-tile-status' }, [
                    App.statusBadge(game.operation_status)
                ])
            ]);
            grid.appendChild(tile);
        });
    }

    function filterGames() {
        renderGameGrid(allGames);
    }

    function renderActiveOverrides(overrides) {
        const el = document.getElementById('active-overrides');
        if (!el) return;
        el.innerHTML = '';

        if (overrides.length === 0) {
            el.appendChild(App.el('p', { className: 'text-muted text-sm', textContent: 'No active overrides.' }));
            return;
        }

        overrides.forEach(o => {
            const card = App.el('div', { className: 'override-card' }, [
                App.el('div', { className: 'override-info' }, [
                    App.el('div', { className: 'override-name', textContent: o.name }),
                    App.el('div', { className: 'override-meta' }, [
                        App.el('span', { textContent: o.group_name + ' \u2022 ' }),
                        App.el('span', { className: o.action === 'pause' ? 'text-warning' : 'text-success', textContent: o.action }),
                        App.el('span', { textContent: ' \u2022 ends ' + App.formatDatetime(o.end_datetime) })
                    ])
                ]),
                App.el('div', { className: 'override-countdown', textContent: App.formatRelative(o.end_datetime) })
            ]);
            el.appendChild(card);
        });
    }

    async function syncGames() {
        const btn = document.getElementById('sync-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }

        try {
            await API.post('games/sync');
            App.toast('Games synced successfully.', 'success');
            await loadDashboard();
        } catch (err) {
            App.toast('Sync failed: ' + err.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Sync Now'; }
        }
    }
})();

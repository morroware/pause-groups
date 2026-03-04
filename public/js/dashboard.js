/**
 * Dashboard page: game status overview, group controls, active overrides.
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

        // Group quick controls
        container.appendChild(App.el('div', { className: 'card mt-2', id: 'group-controls-card' }, [
            App.el('div', { className: 'card-header' }, [
                App.el('div', { className: 'card-title', textContent: 'Quick Controls' })
            ]),
            App.el('div', { id: 'group-controls', className: 'group-controls-grid' })
        ]));

        // Game grid
        container.appendChild(App.el('div', { className: 'card mt-2' }, [
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
            const [gamesData, overridesData, groupsData] = await Promise.all([
                API.get('games'),
                API.get('overrides'),
                API.get('groups')
            ]);

            allGames = gamesData.games || [];
            renderStats(allGames);
            renderGroupControls(groupsData.groups || []);
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

    function renderGroupControls(groups) {
        const el = document.getElementById('group-controls');
        if (!el) return;
        el.innerHTML = '';

        const activeGroups = groups.filter(g => g.is_active == 1);

        if (activeGroups.length === 0) {
            el.appendChild(App.el('p', { className: 'text-muted text-sm', textContent: 'No active groups configured.' }));
            return;
        }

        activeGroups.forEach(group => {
            const stats = group.game_stats || {};
            const state = group.effective_state || 'empty';

            const stateLabel = state === 'paused' ? 'Paused'
                : state === 'enabled' ? 'Running'
                : state === 'mixed' ? 'Mixed'
                : 'No games';

            const stateCls = state === 'paused' ? 'text-warning'
                : state === 'enabled' ? 'text-success'
                : state === 'mixed' ? 'text-secondary'
                : 'text-muted';

            const isPaused = state === 'paused';
            const isEmpty = state === 'empty';

            const card = App.el('div', {
                className: 'group-control-card',
                'data-state': state
            }, [
                App.el('div', { className: 'group-control-info' }, [
                    App.el('div', { className: 'group-control-name', textContent: group.name }),
                    App.el('div', { className: 'group-control-meta' }, [
                        App.el('span', { className: stateCls, textContent: stateLabel }),
                        stats.total > 0 ? App.el('span', {
                            className: 'text-muted',
                            textContent: ' \u2022 ' + stats.total + ' game' + (stats.total !== 1 ? 's' : '')
                                + (stats.out_of_service > 0 ? ' (' + stats.out_of_service + ' OOS)' : '')
                        }) : null
                    ].filter(Boolean))
                ]),
                App.el('div', { className: 'group-control-actions' }, [
                    App.el('button', {
                        className: 'btn btn-sm ' + (isPaused ? 'btn-success' : 'btn-secondary'),
                        textContent: 'Unpause',
                        disabled: isEmpty || state === 'enabled',
                        onClick: () => doGroupAction(group.id, 'unpause', group.name)
                    }),
                    App.el('button', {
                        className: 'btn btn-sm ' + (!isPaused && !isEmpty ? 'btn-warning' : 'btn-secondary'),
                        textContent: 'Pause',
                        disabled: isEmpty || state === 'paused',
                        onClick: () => doGroupAction(group.id, 'pause', group.name)
                    })
                ])
            ]);
            el.appendChild(card);
        });
    }

    async function doGroupAction(groupId, action, groupName) {
        const verb = action === 'pause' ? 'Pause' : 'Unpause';
        const confirmed = await App.confirm(verb + ' all games in "' + groupName + '"?');
        if (!confirmed) return;

        // Disable all group control buttons during the action
        const btns = document.querySelectorAll('.group-control-actions .btn');
        btns.forEach(b => b.disabled = true);

        try {
            const result = await API.post('groups/' + groupId + '/' + action);
            const changed = result.changed || 0;
            const skipped = result.skipped || 0;
            const errors = result.errors || 0;

            if (errors > 0) {
                App.toast(verb + ' partially failed: ' + changed + ' changed, ' + errors + ' errors.', 'warning');
            } else if (changed > 0) {
                App.toast(groupName + ' ' + action + 'd successfully (' + changed + ' game' + (changed !== 1 ? 's' : '') + ').', 'success');
            } else {
                App.toast('All games already ' + action + 'd.', 'info');
            }

            await loadDashboard();
        } catch (err) {
            App.toast(verb + ' failed: ' + err.message, 'error');
        } finally {
            const btnsAfter = document.querySelectorAll('.group-control-actions .btn');
            btnsAfter.forEach(b => b.disabled = false);
        }
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

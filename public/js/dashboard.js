/**
 * Dashboard — Command Center for pause group automation.
 */
(function() {
    App.registerRoute('#/dashboard', { render: renderDashboard });

    function renderDashboard(container) {
        let refreshInterval = null;

        // Page header
        container.appendChild(App.el('div', { className: 'page-header' }, [
            App.el('div', {}, [
                App.el('h1', { className: 'page-title', textContent: 'Command Center' }),
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

        // Group controls
        container.appendChild(App.el('div', { className: 'card mt-2', id: 'group-controls-card' }, [
            App.el('div', { className: 'card-header' }, [
                App.el('div', { className: 'card-title', textContent: 'Group Controls' }),
                App.el('div', { className: 'flex gap-sm', id: 'master-controls' })
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
        const masterEl = document.getElementById('master-controls');
        if (!el) return;
        el.innerHTML = '';
        if (masterEl) masterEl.innerHTML = '';

        var activeGroups = groups.filter(function(g) { return g.is_active == 1; });

        if (activeGroups.length === 0) {
            el.appendChild(App.el('div', { className: 'empty-state', style: { padding: '2rem' } }, [
                App.el('div', { className: 'empty-state-icon', textContent: '\u25CB' }),
                App.el('div', { className: 'empty-state-text', textContent: 'No active groups configured.' }),
                App.el('div', { className: 'empty-state-action' }, [
                    App.el('button', {
                        className: 'btn btn-primary btn-sm',
                        textContent: 'Create Group',
                        onClick: function() { window.location.hash = '#/groups/new'; }
                    })
                ])
            ]));
            return;
        }

        // Master controls
        if (masterEl && activeGroups.length > 1) {
            var hasAnyPaused = activeGroups.some(function(g) { return g.effective_state === 'paused' || g.effective_state === 'mixed'; });
            var hasAnyEnabled = activeGroups.some(function(g) { return g.effective_state === 'enabled' || g.effective_state === 'mixed'; });

            if (hasAnyPaused) {
                masterEl.appendChild(App.el('button', {
                    className: 'btn btn-sm btn-success',
                    textContent: 'Unpause All',
                    onClick: function() { doBulkAction('unpause', activeGroups); }
                }));
            }
            if (hasAnyEnabled) {
                masterEl.appendChild(App.el('button', {
                    className: 'btn btn-sm btn-warning',
                    textContent: 'Pause All',
                    onClick: function() { doBulkAction('pause', activeGroups); }
                }));
            }
        }

        activeGroups.forEach(function(group) {
            var stats = group.game_stats || {};
            var state = group.effective_state || 'empty';
            var override = group.active_override;
            var nextTrans = group.next_transition;

            var stateLabel = state === 'paused' ? 'Paused'
                : state === 'enabled' ? 'Running'
                : state === 'mixed' ? 'Mixed'
                : 'No Games';

            var isPaused = state === 'paused';
            var isEnabled = state === 'enabled';
            var isEmpty = state === 'empty';

            var card = App.el('div', {
                className: 'group-control-card',
                'data-state': state
            });

            // Header: status dot + name | state badge
            card.appendChild(App.el('div', { className: 'group-control-header' }, [
                App.el('div', { className: 'group-control-title' }, [
                    App.el('span', { className: 'status-dot status-dot-' + state }),
                    App.el('span', { className: 'group-control-name', textContent: group.name })
                ]),
                App.el('span', {
                    className: 'group-control-state group-control-state-' + state,
                    textContent: stateLabel
                })
            ]));

            // Stats: game count + progress bar + breakdown
            if (stats.total > 0) {
                var enabledPct = (stats.enabled / stats.total * 100).toFixed(1);
                var pausedPct = (stats.paused / stats.total * 100).toFixed(1);
                var oosPct = (stats.out_of_service / stats.total * 100).toFixed(1);

                card.appendChild(App.el('div', { className: 'group-control-stats' }, [
                    App.el('span', { className: 'text-muted', textContent: stats.total + ' game' + (stats.total !== 1 ? 's' : '') }),
                    App.el('div', { className: 'progress-bar' }, [
                        App.el('div', { className: 'progress-fill-enabled', style: { width: enabledPct + '%' } }),
                        App.el('div', { className: 'progress-fill-paused', style: { width: pausedPct + '%' } }),
                        App.el('div', { className: 'progress-fill-oos', style: { width: oosPct + '%' } })
                    ]),
                    App.el('span', { className: 'text-xs' }, [
                        App.el('span', { className: 'text-success', textContent: String(stats.enabled) }),
                        App.el('span', { className: 'text-muted', textContent: ' / ' }),
                        App.el('span', { className: 'text-warning', textContent: String(stats.paused) }),
                        stats.out_of_service > 0
                            ? App.el('span', { className: 'text-muted', textContent: ' / ' })
                            : null,
                        stats.out_of_service > 0
                            ? App.el('span', { className: 'text-danger', textContent: String(stats.out_of_service) })
                            : null
                    ].filter(Boolean))
                ]));
            }

            // Context: active override or next scheduled transition
            if (override) {
                card.appendChild(App.el('div', { className: 'group-control-context group-control-context-override' }, [
                    App.el('span', { textContent: '\u26A1' }),
                    App.el('span', { style: { fontWeight: '500' }, textContent: override.name }),
                    App.el('span', { style: { opacity: '0.7' }, textContent: ' \u2022 ' + override.action + ' \u2022 ends ' + App.formatDatetime(override.end_datetime) })
                ]));
            } else if (nextTrans) {
                card.appendChild(App.el('div', { className: 'group-control-context' }, [
                    App.el('span', { textContent: '\u25F4' }),
                    App.el('span', { textContent: (nextTrans.action === 'pause' ? 'Pause' : 'Unpause') + ' scheduled at ' + App.formatTime(nextTrans.time) })
                ]));
            }

            // Action buttons
            var actionRow = App.el('div', { className: 'group-control-actions' });

            if (isEmpty) {
                actionRow.appendChild(App.el('span', { className: 'text-muted text-xs', style: { padding: '0.35rem 0', display: 'block', textAlign: 'center', width: '100%' }, textContent: 'No games assigned to this group' }));
            } else if (state === 'mixed') {
                actionRow.appendChild(App.el('button', {
                    className: 'btn btn-success',
                    textContent: 'Unpause All',
                    onClick: function() { doGroupAction(group.id, 'unpause', group.name, stats.total); }
                }));
                actionRow.appendChild(App.el('button', {
                    className: 'btn btn-warning',
                    textContent: 'Pause All',
                    onClick: function() { doGroupAction(group.id, 'pause', group.name, stats.total); }
                }));
            } else if (isPaused) {
                actionRow.appendChild(App.el('button', {
                    className: 'btn btn-success',
                    textContent: 'Unpause Group',
                    onClick: function() { doGroupAction(group.id, 'unpause', group.name, stats.total); }
                }));
            } else {
                actionRow.appendChild(App.el('button', {
                    className: 'btn btn-warning',
                    textContent: 'Pause Group',
                    onClick: function() { doGroupAction(group.id, 'pause', group.name, stats.total); }
                }));
            }

            card.appendChild(actionRow);
            el.appendChild(card);
        });
    }

    async function doGroupAction(groupId, action, groupName, gameCount) {
        var verb = action === 'pause' ? 'Pause' : 'Unpause';
        var msg = verb + ' all ' + gameCount + ' game' + (gameCount !== 1 ? 's' : '') + ' in "' + groupName + '"?';
        var confirmed = await App.confirm(msg);
        if (!confirmed) return;

        setControlsLoading(true);

        try {
            var result = await API.post('groups/' + groupId + '/' + action);
            var changed = result.changed || 0;
            var errors = result.errors || 0;

            if (errors > 0) {
                App.toast(verb + ' partially failed: ' + changed + ' changed, ' + errors + ' error(s).', 'warning');
            } else if (changed > 0) {
                App.toast(groupName + ': ' + changed + ' game' + (changed !== 1 ? 's' : '') + ' ' + action + 'd.', 'success');
            } else {
                App.toast(groupName + ': all games already ' + action + 'd.', 'info');
            }

            await loadDashboard();
        } catch (err) {
            App.toast(verb + ' failed: ' + err.message, 'error');
        } finally {
            setControlsLoading(false);
        }
    }

    async function doBulkAction(action, groups) {
        var verb = action === 'pause' ? 'Pause' : 'Unpause';
        var count = groups.length;
        var confirmed = await App.confirm(verb + ' all games across ' + count + ' group' + (count !== 1 ? 's' : '') + '?');
        if (!confirmed) return;

        setControlsLoading(true);

        var totalChanged = 0;
        var totalErrors = 0;

        try {
            for (var i = 0; i < groups.length; i++) {
                var g = groups[i];
                if (g.effective_state === 'empty') continue;
                if (action === 'pause' && g.effective_state === 'paused') continue;
                if (action === 'unpause' && g.effective_state === 'enabled') continue;

                try {
                    var result = await API.post('groups/' + g.id + '/' + action);
                    totalChanged += result.changed || 0;
                    totalErrors += result.errors || 0;
                } catch (err) {
                    totalErrors++;
                }
            }

            if (totalErrors > 0) {
                App.toast(verb + ' completed with errors: ' + totalChanged + ' changed, ' + totalErrors + ' error(s).', 'warning');
            } else if (totalChanged > 0) {
                App.toast('All groups ' + action + 'd: ' + totalChanged + ' game' + (totalChanged !== 1 ? 's' : '') + ' updated.', 'success');
            } else {
                App.toast('All games already ' + action + 'd.', 'info');
            }

            await loadDashboard();
        } catch (err) {
            App.toast('Bulk ' + action + ' failed: ' + err.message, 'error');
        } finally {
            setControlsLoading(false);
        }
    }

    function setControlsLoading(loading) {
        var btns = document.querySelectorAll('#group-controls-card .btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].disabled = loading;
        }
    }

    function renderGameGrid(games) {
        var grid = document.getElementById('game-grid');
        if (!grid) return;
        grid.innerHTML = '';

        if (games.length === 0) {
            grid.appendChild(App.emptyState('\u{1F3AE}', 'No games found. Configure CenterEdge API in Settings.'));
            return;
        }

        var searchVal = (document.getElementById('game-search')?.value || '').toLowerCase();
        var filtered = searchVal ? games.filter(function(g) { return g.game_name.toLowerCase().includes(searchVal); }) : games;

        filtered.forEach(function(game) {
            var tile = App.el('div', {
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
        var el = document.getElementById('active-overrides');
        if (!el) return;
        el.innerHTML = '';

        if (overrides.length === 0) {
            el.appendChild(App.el('p', { className: 'text-muted text-sm', textContent: 'No active overrides.' }));
            return;
        }

        overrides.forEach(function(o) {
            var card = App.el('div', { className: 'override-card' }, [
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
        var btn = document.getElementById('sync-btn');
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

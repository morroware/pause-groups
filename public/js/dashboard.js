/**
 * Dashboard — Command Center for pause group automation.
 *
 * Polling strategy:
 *   - Default: every 30 seconds
 *   - Active override exists: every 10 seconds
 *   - Override about to expire (< 2 min): every 5 seconds
 *   - Override just expired: immediate enforce call + refresh
 *
 * Scalable UI: supports hundreds of games with table view,
 * pagination, filtering, and sorting.
 */
(function() {
    App.registerRoute('#/dashboard', { render: renderDashboard });

    // Polling constants
    var INTERVAL_DEFAULT = 30000;
    var INTERVAL_OVERRIDE_ACTIVE = 10000;
    var INTERVAL_OVERRIDE_EXPIRING = 5000;

    // Module-level state
    var allGames = [];
    var refreshInterval = null;
    var expiryTimers = [];
    var currentInterval = INTERVAL_DEFAULT;

    // View state
    var gameView = 'table'; // 'grid' or 'table'
    var gameStatusFilter = 'all'; // 'all', 'enabled', 'paused', 'outOfService'
    var gameSearchTerm = '';
    var gameSortCol = 'game_name';
    var gameSortDir = 'asc';
    var gamePage = 1;
    var gamePageSize = 25;
    var groupsCollapsed = false;

    function scheduleNextPoll() {
        if (refreshInterval) clearInterval(refreshInterval);
        refreshInterval = setInterval(loadDashboard, currentInterval);
    }

    function adjustPollingRate(activeOverrides) {
        var newInterval = INTERVAL_DEFAULT;

        if (activeOverrides && activeOverrides.length > 0) {
            var soonestMs = Infinity;
            var now = Date.now();
            activeOverrides.forEach(function(o) {
                var endMs = new Date(o.end_datetime.replace(' ', 'T')).getTime();
                var remaining = endMs - now;
                if (remaining < soonestMs) soonestMs = remaining;
            });

            if (soonestMs <= 120000) {
                newInterval = INTERVAL_OVERRIDE_EXPIRING;
            } else {
                newInterval = INTERVAL_OVERRIDE_ACTIVE;
            }
        }

        if (newInterval !== currentInterval) {
            currentInterval = newInterval;
            scheduleNextPoll();
        }
    }

    function scheduleExpiryTimers(activeOverrides) {
        expiryTimers.forEach(function(t) { clearTimeout(t); });
        expiryTimers = [];

        if (!activeOverrides || activeOverrides.length === 0) return;

        var now = Date.now();
        activeOverrides.forEach(function(o) {
            var endMs = new Date(o.end_datetime.replace(' ', 'T')).getTime();
            var delay = endMs - now;

            if (delay > 0 && delay < 3600000) {
                // Fire right at expiry: call enforce endpoint then refresh
                var timer = setTimeout(function() {
                    onOverrideExpired(o);
                }, delay + 1000); // +1s to ensure server sees it as expired
                expiryTimers.push(timer);

                // Follow-up refresh 3s after expiry for UI consistency
                var timer2 = setTimeout(function() {
                    loadDashboard();
                }, delay + 3000);
                expiryTimers.push(timer2);
            }
        });
    }

    async function onOverrideExpired(override) {
        var groupId = override.pause_group_id;
        if (groupId) {
            try {
                await API.post('groups/' + groupId + '/enforce');
            } catch (err) {
                // Enforcement failed — next poll will still trigger server-side safety net
            }
        }
        await loadDashboard();
    }

    function renderDashboard(container) {
        currentInterval = INTERVAL_DEFAULT;

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
        var statsGrid = App.el('div', { className: 'stats-grid', id: 'stats-grid' });
        container.appendChild(statsGrid);

        // Group controls (collapsible)
        container.appendChild(App.el('div', { className: 'card mt-2', id: 'group-controls-card' }, [
            App.el('div', { className: 'card-header' }, [
                App.el('div', { className: 'flex-center gap-sm' }, [
                    App.el('div', { className: 'card-title', textContent: 'Group Controls' }),
                    App.el('span', { className: 'badge badge-info', id: 'group-count-badge', textContent: '0 groups' })
                ]),
                App.el('div', { className: 'flex-center gap-sm' }, [
                    App.el('div', { className: 'flex gap-sm', id: 'master-controls' }),
                    App.el('button', {
                        className: 'section-collapse-btn',
                        id: 'groups-collapse-btn',
                        textContent: groupsCollapsed ? 'Expand' : 'Collapse',
                        onClick: function() {
                            groupsCollapsed = !groupsCollapsed;
                            this.textContent = groupsCollapsed ? 'Expand' : 'Collapse';
                            var grid = document.getElementById('group-controls');
                            if (grid) grid.style.display = groupsCollapsed ? 'none' : '';
                            var summary = document.getElementById('groups-summary');
                            if (summary) summary.style.display = groupsCollapsed ? '' : 'none';
                        }
                    })
                ])
            ]),
            App.el('div', { id: 'groups-summary', className: 'groups-summary-bar', style: { display: groupsCollapsed ? '' : 'none' } }),
            App.el('div', { id: 'group-controls', className: 'group-controls-grid', style: { display: groupsCollapsed ? 'none' : '' } })
        ]));

        // Game status section with toolbar
        var gameCard = App.el('div', { className: 'card mt-2', id: 'game-status-card' });

        // Card header with title + view toggle
        gameCard.appendChild(App.el('div', { className: 'card-header' }, [
            App.el('div', { className: 'flex-center gap-sm' }, [
                App.el('div', { className: 'card-title', textContent: 'Game Status' }),
                App.el('span', { className: 'badge badge-info', id: 'game-count-badge', textContent: '0 games' })
            ]),
            App.el('div', { className: 'view-toggle', id: 'view-toggle' }, [
                App.el('button', {
                    className: 'view-toggle-btn' + (gameView === 'table' ? ' active' : ''),
                    textContent: 'Table',
                    'data-view': 'table',
                    onClick: function() { switchView('table'); }
                }),
                App.el('button', {
                    className: 'view-toggle-btn' + (gameView === 'grid' ? ' active' : ''),
                    textContent: 'Grid',
                    'data-view': 'grid',
                    onClick: function() { switchView('grid'); }
                })
            ])
        ]));

        // Toolbar: search + status filter pills
        var toolbar = App.el('div', { className: 'toolbar-row', id: 'game-toolbar' });
        toolbar.appendChild(App.el('input', {
            className: 'form-input', type: 'text', placeholder: 'Search games...',
            id: 'game-search',
            style: { maxWidth: '240px', fontSize: '0.82rem', padding: '0.4rem 0.65rem' },
            onInput: function() {
                gameSearchTerm = this.value.toLowerCase();
                gamePage = 1;
                renderGameView(allGames);
            }
        }));
        toolbar.appendChild(App.el('div', { className: 'filter-pills', id: 'status-filters' }));
        gameCard.appendChild(toolbar);

        // Game content area
        gameCard.appendChild(App.el('div', { id: 'game-content' }));

        container.appendChild(gameCard);

        // Active overrides section
        container.appendChild(App.el('div', { className: 'card mt-2', id: 'active-overrides-card' }, [
            App.el('div', { className: 'card-title', textContent: 'Active Overrides' }),
            App.el('div', { id: 'active-overrides', className: 'mt-1' })
        ]));

        loadDashboard();
        scheduleNextPoll();

        return function cleanup() {
            if (refreshInterval) clearInterval(refreshInterval);
            refreshInterval = null;
            expiryTimers.forEach(function(t) { clearTimeout(t); });
            expiryTimers = [];
        };
    }

    function switchView(view) {
        gameView = view;
        // Update toggle buttons
        var btns = document.querySelectorAll('#view-toggle .view-toggle-btn');
        btns.forEach(function(btn) {
            btn.classList.toggle('active', btn.getAttribute('data-view') === view);
        });
        gamePage = 1;
        renderGameView(allGames);
    }

    async function loadDashboard() {
        try {
            var results = await Promise.all([
                API.get('games'),
                API.get('overrides'),
                API.get('groups')
            ]);
            var gamesData = results[0];
            var overridesData = results[1];
            var groupsData = results[2];

            allGames = gamesData.games || [];
            var activeOverrides = overridesData.active || [];

            renderStats(allGames);
            renderGroupControls(groupsData.groups || []);
            renderStatusFilters(allGames);
            renderGameView(allGames);
            renderActiveOverrides(activeOverrides);

            // Update game count badge
            var badge = document.getElementById('game-count-badge');
            if (badge) badge.textContent = allGames.length + ' game' + (allGames.length !== 1 ? 's' : '');

            // Adjust polling rate based on active overrides
            adjustPollingRate(activeOverrides);

            // Schedule precise timers for override expiry
            scheduleExpiryTimers(activeOverrides);

            var syncEl = document.getElementById('last-sync');
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
        var grid = document.getElementById('stats-grid');
        if (!grid) return;
        grid.innerHTML = '';

        var total = games.length;
        var enabled = games.filter(function(g) { return g.operation_status === 'enabled'; }).length;
        var paused = games.filter(function(g) { return g.operation_status === 'paused'; }).length;
        var oos = games.filter(function(g) { return g.operation_status === 'outOfService'; }).length;

        var stats = [
            { label: 'Total Games', value: total, cls: '' },
            { label: 'Enabled', value: enabled, cls: 'text-success' },
            { label: 'Paused', value: paused, cls: 'text-warning' },
            { label: 'Out of Service', value: oos, cls: 'text-danger' },
        ];

        stats.forEach(function(s) {
            grid.appendChild(App.el('div', { className: 'stat-card' }, [
                App.el('div', { className: 'stat-label', textContent: s.label }),
                App.el('div', { className: 'stat-value ' + s.cls, textContent: String(s.value) })
            ]));
        });
    }

    function renderStatusFilters(games) {
        var el = document.getElementById('status-filters');
        if (!el) return;
        el.innerHTML = '';

        var total = games.length;
        var enabled = games.filter(function(g) { return g.operation_status === 'enabled'; }).length;
        var paused = games.filter(function(g) { return g.operation_status === 'paused'; }).length;
        var oos = games.filter(function(g) { return g.operation_status === 'outOfService'; }).length;

        var filters = [
            { key: 'all', label: 'All', count: total, activeCls: 'active' },
            { key: 'enabled', label: 'Enabled', count: enabled, activeCls: 'active-enabled' },
            { key: 'paused', label: 'Paused', count: paused, activeCls: 'active-paused' },
            { key: 'outOfService', label: 'Out of Service', count: oos, activeCls: 'active-oos' },
        ];

        filters.forEach(function(f) {
            var pill = App.el('button', {
                className: 'filter-pill' + (gameStatusFilter === f.key ? ' ' + f.activeCls : ''),
                onClick: function() {
                    gameStatusFilter = f.key;
                    gamePage = 1;
                    renderStatusFilters(allGames);
                    renderGameView(allGames);
                }
            }, [
                App.el('span', { textContent: f.label }),
                App.el('span', { className: 'pill-count', textContent: '(' + f.count + ')' })
            ]);
            el.appendChild(pill);
        });
    }

    function getFilteredSortedGames(games) {
        // Filter by search
        var filtered = games;
        if (gameSearchTerm) {
            filtered = filtered.filter(function(g) {
                return g.game_name.toLowerCase().includes(gameSearchTerm);
            });
        }
        // Filter by status
        if (gameStatusFilter !== 'all') {
            filtered = filtered.filter(function(g) {
                return g.operation_status === gameStatusFilter;
            });
        }
        // Sort
        filtered.sort(function(a, b) {
            var aVal, bVal;
            if (gameSortCol === 'game_name') {
                aVal = (a.game_name || '').toLowerCase();
                bVal = (b.game_name || '').toLowerCase();
            } else if (gameSortCol === 'operation_status') {
                var order = { enabled: 0, paused: 1, outOfService: 2 };
                aVal = order[a.operation_status] !== undefined ? order[a.operation_status] : 3;
                bVal = order[b.operation_status] !== undefined ? order[b.operation_status] : 3;
            } else if (gameSortCol === 'game_id') {
                aVal = a.game_id || '';
                bVal = b.game_id || '';
            } else {
                aVal = a[gameSortCol] || '';
                bVal = b[gameSortCol] || '';
            }

            if (aVal < bVal) return gameSortDir === 'asc' ? -1 : 1;
            if (aVal > bVal) return gameSortDir === 'asc' ? 1 : -1;
            return 0;
        });

        return filtered;
    }

    function renderGameView(games) {
        var el = document.getElementById('game-content');
        if (!el) return;
        el.innerHTML = '';

        if (games.length === 0) {
            el.appendChild(App.emptyState('\uD83C\uDFAE', 'No games found. Configure CenterEdge API in Settings.'));
            return;
        }

        var filtered = getFilteredSortedGames(games);

        if (filtered.length === 0) {
            el.appendChild(App.el('div', { className: 'empty-state', style: { padding: '2rem' } }, [
                App.el('div', { className: 'empty-state-text', textContent: 'No games match the current filters.' })
            ]));
            return;
        }

        if (gameView === 'table') {
            renderGameTable(el, filtered);
        } else {
            renderGameGrid(el, filtered);
        }
    }

    function renderGameTable(container, filtered) {
        var totalItems = filtered.length;
        var totalPages = Math.ceil(totalItems / gamePageSize);
        if (gamePage > totalPages) gamePage = totalPages;
        if (gamePage < 1) gamePage = 1;

        var startIdx = (gamePage - 1) * gamePageSize;
        var pageItems = filtered.slice(startIdx, startIdx + gamePageSize);

        // Scrollable table
        var scrollContainer = App.el('div', { className: 'table-scroll-container' });
        var table = App.el('table', { className: 'table' });

        // Header
        var thead = App.el('thead');
        var headerRow = App.el('tr');

        var columns = [
            { key: 'game_name', label: 'Game Name', sortable: true },
            { key: 'game_id', label: 'Game ID', sortable: true },
            { key: 'operation_status', label: 'Status', sortable: true },
            { key: 'categories', label: 'Categories', sortable: false }
        ];

        columns.forEach(function(col) {
            var th = App.el('th', {
                className: (col.sortable ? 'sortable' : '') + (gameSortCol === col.key ? ' sorted' : '')
            });
            th.appendChild(App.el('span', { textContent: col.label }));
            if (col.sortable) {
                var sortIcon = gameSortCol === col.key
                    ? (gameSortDir === 'asc' ? '\u25B2' : '\u25BC')
                    : '\u25B4';
                th.appendChild(App.el('span', { className: 'sort-icon', textContent: sortIcon }));
                th.addEventListener('click', function() {
                    if (gameSortCol === col.key) {
                        gameSortDir = gameSortDir === 'asc' ? 'desc' : 'asc';
                    } else {
                        gameSortCol = col.key;
                        gameSortDir = 'asc';
                    }
                    renderGameView(allGames);
                });
            }
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        var tbody = App.el('tbody');
        pageItems.forEach(function(game) {
            var row = App.el('tr');

            // Game name
            row.appendChild(App.el('td', {}, [
                App.el('span', { textContent: game.game_name, style: { fontWeight: '500' } })
            ]));

            // Game ID
            row.appendChild(App.el('td', {
                className: 'text-muted text-sm font-mono',
                textContent: game.game_id || '-'
            }));

            // Status badge
            row.appendChild(App.el('td', {}, [
                App.statusBadge(game.operation_status)
            ]));

            // Categories
            var cats = game.categories || [];
            var catText = cats.length > 0
                ? (typeof cats[0] === 'object' ? cats.map(function(c) { return c.name || c; }).join(', ') : cats.join(', '))
                : '-';
            row.appendChild(App.el('td', {
                className: 'text-sm text-secondary',
                textContent: catText,
                style: { maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: catText
            }));

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        scrollContainer.appendChild(table);
        container.appendChild(scrollContainer);

        // Pagination bar
        if (totalPages > 1 || totalItems > 25) {
            container.appendChild(buildGamePagination(totalItems, totalPages));
        }
    }

    function buildGamePagination(totalItems, totalPages) {
        var bar = App.el('div', { className: 'pagination-bar' });

        var startIdx = (gamePage - 1) * gamePageSize + 1;
        var endIdx = Math.min(gamePage * gamePageSize, totalItems);

        bar.appendChild(App.el('div', { className: 'pagination-info' }, [
            App.el('span', { textContent: 'Showing ' + startIdx + '-' + endIdx + ' of ' + totalItems }),
            App.el('select', {
                className: 'page-size-select',
                onChange: function() {
                    gamePageSize = parseInt(this.value);
                    gamePage = 1;
                    renderGameView(allGames);
                }
            }, [25, 50, 100].map(function(size) {
                var opt = App.el('option', { value: String(size), textContent: size + ' / page' });
                if (size === gamePageSize) opt.selected = true;
                return opt;
            }))
        ]));

        var controls = App.el('div', { className: 'pagination-controls' });

        // First
        controls.appendChild(App.el('button', {
            className: 'btn btn-ghost btn-sm',
            textContent: '\u00AB',
            disabled: gamePage <= 1,
            title: 'First page',
            onClick: function() { gamePage = 1; renderGameView(allGames); }
        }));

        // Previous
        controls.appendChild(App.el('button', {
            className: 'btn btn-ghost btn-sm',
            textContent: '\u2039',
            disabled: gamePage <= 1,
            title: 'Previous page',
            onClick: function() { gamePage--; renderGameView(allGames); }
        }));

        // Page indicator
        controls.appendChild(App.el('span', {
            className: 'text-sm',
            style: { padding: '0 0.5rem' },
            textContent: gamePage + ' / ' + totalPages
        }));

        // Next
        controls.appendChild(App.el('button', {
            className: 'btn btn-ghost btn-sm',
            textContent: '\u203A',
            disabled: gamePage >= totalPages,
            title: 'Next page',
            onClick: function() { gamePage++; renderGameView(allGames); }
        }));

        // Last
        controls.appendChild(App.el('button', {
            className: 'btn btn-ghost btn-sm',
            textContent: '\u00BB',
            disabled: gamePage >= totalPages,
            title: 'Last page',
            onClick: function() { gamePage = totalPages; renderGameView(allGames); }
        }));

        bar.appendChild(controls);
        return bar;
    }

    function renderGameGrid(container, filtered) {
        // In grid mode, paginate too for large sets
        var totalItems = filtered.length;
        var totalPages = Math.ceil(totalItems / gamePageSize);
        if (gamePage > totalPages) gamePage = totalPages;
        if (gamePage < 1) gamePage = 1;

        var startIdx = (gamePage - 1) * gamePageSize;
        var pageItems = filtered.slice(startIdx, startIdx + gamePageSize);

        var grid = App.el('div', { className: 'game-grid' });
        pageItems.forEach(function(game) {
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
        container.appendChild(grid);

        // Pagination bar
        if (totalPages > 1 || totalItems > 25) {
            container.appendChild(buildGamePagination(totalItems, totalPages));
        }
    }

    function renderGroupControls(groups) {
        var el = document.getElementById('group-controls');
        var masterEl = document.getElementById('master-controls');
        var summaryEl = document.getElementById('groups-summary');
        var countBadge = document.getElementById('group-count-badge');
        if (!el) return;
        el.innerHTML = '';
        if (masterEl) masterEl.innerHTML = '';
        if (summaryEl) summaryEl.innerHTML = '';

        var activeGroups = groups.filter(function(g) { return g.is_active == 1; });

        // Update count badge
        if (countBadge) countBadge.textContent = activeGroups.length + ' active group' + (activeGroups.length !== 1 ? 's' : '');

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

        // Collapsed summary view
        if (summaryEl) {
            activeGroups.forEach(function(group) {
                var state = group.effective_state || 'empty';
                var stats = group.game_stats || {};
                var item = App.el('div', { className: 'groups-summary-item' }, [
                    App.el('span', { className: 'status-dot status-dot-' + state }),
                    App.el('span', { textContent: group.name, style: { fontWeight: '500', fontSize: '0.82rem' } }),
                    App.el('span', {
                        className: 'text-xs text-muted',
                        textContent: (stats.total || 0) + ' games'
                    })
                ]);
                summaryEl.appendChild(item);
            });
        }

        // Full card view
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

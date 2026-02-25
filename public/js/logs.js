/**
 * Action log viewer: paginated table with filters.
 */
(function() {
    App.registerRoute('#/logs', { render: renderLogs });

    let filters = {};
    let currentPage = 1;
    const perPage = 50;

    async function renderLogs(container) {
        filters = {};
        currentPage = 1;

        container.appendChild(App.el('div', { className: 'page-header' }, [
            App.el('h1', { className: 'page-title', textContent: 'Action Log' })
        ]));

        // Filters bar
        const filtersBar = buildFiltersBar();
        container.appendChild(filtersBar);

        const content = App.el('div', { id: 'logs-content' });
        content.appendChild(App.loading());
        container.appendChild(content);

        await loadLogs();
    }

    function buildFiltersBar() {
        const bar = App.el('div', { className: 'card', style: { marginBottom: '1.5rem', padding: '1rem' } });

        const row = App.el('div', { className: 'form-row', style: { flexWrap: 'wrap', gap: '0.75rem' } });

        // Date range
        const dateFrom = App.el('input', {
            className: 'form-input', type: 'date',
            style: { maxWidth: '160px' },
            onChange: () => { filters.date_from = dateFrom.value || undefined; currentPage = 1; loadLogs(); }
        });
        const dateTo = App.el('input', {
            className: 'form-input', type: 'date',
            style: { maxWidth: '160px' },
            onChange: () => { filters.date_to = dateTo.value || undefined; currentPage = 1; loadLogs(); }
        });

        row.appendChild(App.el('div', { className: 'form-group', style: { marginBottom: 0, flex: 'none' } }, [
            App.el('label', { className: 'form-label', textContent: 'From', style: { fontSize: '0.75rem' } }),
            dateFrom
        ]));
        row.appendChild(App.el('div', { className: 'form-group', style: { marginBottom: 0, flex: 'none' } }, [
            App.el('label', { className: 'form-label', textContent: 'To', style: { fontSize: '0.75rem' } }),
            dateTo
        ]));

        // Source filter
        const sourceSelect = App.el('select', {
            className: 'form-select', style: { maxWidth: '140px' },
            onChange: () => { filters.source = sourceSelect.value || undefined; currentPage = 1; loadLogs(); }
        });
        sourceSelect.appendChild(App.el('option', { value: '', textContent: 'All Sources' }));
        ['cron', 'manual', 'override', 'schedule'].forEach(s => {
            sourceSelect.appendChild(App.el('option', { value: s, textContent: s }));
        });

        row.appendChild(App.el('div', { className: 'form-group', style: { marginBottom: 0, flex: 'none' } }, [
            App.el('label', { className: 'form-label', textContent: 'Source', style: { fontSize: '0.75rem' } }),
            sourceSelect
        ]));

        // Action filter
        const actionSelect = App.el('select', {
            className: 'form-select', style: { maxWidth: '140px' },
            onChange: () => { filters.action = actionSelect.value || undefined; currentPage = 1; loadLogs(); }
        });
        actionSelect.appendChild(App.el('option', { value: '', textContent: 'All Actions' }));
        ['pause', 'unpause', 'skip', 'plan_day', 'execute_action'].forEach(a => {
            actionSelect.appendChild(App.el('option', { value: a, textContent: a }));
        });

        row.appendChild(App.el('div', { className: 'form-group', style: { marginBottom: 0, flex: 'none' } }, [
            App.el('label', { className: 'form-label', textContent: 'Action', style: { fontSize: '0.75rem' } }),
            actionSelect
        ]));

        // Status filter
        const statusSelect = App.el('select', {
            className: 'form-select', style: { maxWidth: '130px' },
            onChange: () => { filters.success = statusSelect.value === '' ? undefined : statusSelect.value; currentPage = 1; loadLogs(); }
        });
        statusSelect.appendChild(App.el('option', { value: '', textContent: 'All Status' }));
        statusSelect.appendChild(App.el('option', { value: '1', textContent: 'Success' }));
        statusSelect.appendChild(App.el('option', { value: '0', textContent: 'Failed' }));

        row.appendChild(App.el('div', { className: 'form-group', style: { marginBottom: 0, flex: 'none' } }, [
            App.el('label', { className: 'form-label', textContent: 'Status', style: { fontSize: '0.75rem' } }),
            statusSelect
        ]));

        bar.appendChild(row);
        return bar;
    }

    async function loadLogs() {
        const content = document.getElementById('logs-content');
        if (!content) return;

        try {
            const params = new URLSearchParams();
            params.set('page', String(currentPage));
            params.set('per_page', String(perPage));
            if (filters.date_from) params.set('from', filters.date_from);
            if (filters.date_to) params.set('to', filters.date_to);
            if (filters.source) params.set('source', filters.source);
            if (filters.action) params.set('action', filters.action);
            if (filters.success !== undefined) params.set('success', filters.success);

            const data = await API.get('logs?' + params.toString());
            content.innerHTML = '';

            if (!data.logs || data.logs.length === 0) {
                content.appendChild(App.el('div', { className: 'empty-state' }, [
                    App.el('div', { className: 'empty-state-icon', textContent: '\uD83D\uDCCB' }),
                    App.el('div', { className: 'empty-state-text', textContent: 'No log entries found.' })
                ]));
                return;
            }

            // Table
            const table = App.el('table', { className: 'table' });

            const thead = App.el('thead');
            thead.appendChild(App.el('tr', {}, [
                App.el('th', { textContent: 'Time' }),
                App.el('th', { textContent: 'Source' }),
                App.el('th', { textContent: 'Action' }),
                App.el('th', { textContent: 'Group' }),
                App.el('th', { textContent: 'Details' }),
                App.el('th', { textContent: 'Status' })
            ]));
            table.appendChild(thead);

            const tbody = App.el('tbody');
            data.logs.forEach(log => {
                const row = App.el('tr', {
                    className: log.success ? '' : 'row-error'
                });

                row.appendChild(App.el('td', {
                    textContent: App.formatDatetime(log.timestamp),
                    style: { whiteSpace: 'nowrap', fontSize: '0.8rem' }
                }));

                row.appendChild(App.el('td', {}, [
                    App.el('span', {
                        className: 'badge badge-info',
                        textContent: log.source || '\u2014',
                        style: { fontSize: '0.7rem' }
                    })
                ]));

                row.appendChild(App.el('td', { textContent: log.action || '\u2014' }));
                row.appendChild(App.el('td', { textContent: log.group_name || '\u2014' }));

                // Details: show game_name + error_message if any
                const detailParts = [];
                if (log.game_name) detailParts.push(log.game_name);
                if (log.error_message) detailParts.push(log.error_message);
                const detailText = detailParts.join(' \u2014 ') || '\u2014';

                row.appendChild(App.el('td', {
                    textContent: detailText,
                    style: { maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    title: detailText
                }));

                row.appendChild(App.el('td', {}, [
                    App.el('span', {
                        className: 'badge ' + (log.success ? 'badge-active' : 'badge-danger'),
                        textContent: log.success ? 'OK' : 'FAIL'
                    })
                ]));

                tbody.appendChild(row);
            });
            table.appendChild(tbody);

            const wrapper = App.el('div', { className: 'table-responsive' });
            wrapper.appendChild(table);
            content.appendChild(wrapper);

            // Pagination
            const totalPages = Math.ceil((data.total || 0) / perPage);
            if (totalPages > 1) {
                content.appendChild(buildPagination(totalPages));
            }

            // Summary
            content.appendChild(App.el('p', {
                className: 'text-muted text-sm',
                style: { marginTop: '0.5rem' },
                textContent: 'Showing ' + data.logs.length + ' of ' + (data.total || 0) + ' entries'
            }));

        } catch (err) {
            content.innerHTML = '';
            App.toast(err.message, 'error');
        }
    }

    function buildPagination(totalPages) {
        const nav = App.el('div', {
            style: { display: 'flex', justifyContent: 'center', gap: '0.25rem', marginTop: '1rem', flexWrap: 'wrap' }
        });

        // Previous
        if (currentPage > 1) {
            nav.appendChild(App.el('button', {
                className: 'btn btn-ghost btn-sm', textContent: '\u2190 Prev',
                onClick: () => { currentPage--; loadLogs(); }
            }));
        }

        // Page numbers (show max 7 pages around current)
        const start = Math.max(1, currentPage - 3);
        const end = Math.min(totalPages, currentPage + 3);

        if (start > 1) {
            nav.appendChild(pageBtn(1));
            if (start > 2) {
                nav.appendChild(App.el('span', { textContent: '\u2026', style: { padding: '0.25rem 0.5rem', color: 'var(--text-muted)' } }));
            }
        }

        for (let i = start; i <= end; i++) {
            nav.appendChild(pageBtn(i));
        }

        if (end < totalPages) {
            if (end < totalPages - 1) {
                nav.appendChild(App.el('span', { textContent: '\u2026', style: { padding: '0.25rem 0.5rem', color: 'var(--text-muted)' } }));
            }
            nav.appendChild(pageBtn(totalPages));
        }

        // Next
        if (currentPage < totalPages) {
            nav.appendChild(App.el('button', {
                className: 'btn btn-ghost btn-sm', textContent: 'Next \u2192',
                onClick: () => { currentPage++; loadLogs(); }
            }));
        }

        return nav;
    }

    function pageBtn(page) {
        return App.el('button', {
            className: 'btn btn-sm ' + (page === currentPage ? 'btn-primary' : 'btn-ghost'),
            textContent: String(page),
            onClick: () => { currentPage = page; loadLogs(); }
        });
    }
})();

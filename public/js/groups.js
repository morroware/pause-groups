/**
 * Pause group management: list, create, edit, delete.
 */
(function() {
    App.registerRoute('#/groups', { render: renderGroupList });
    App.registerRoute('#/groups/new', { render: renderGroupForm });
    App.registerRoute('#/groups/:id', { render: renderGroupForm });

    async function renderGroupList(container) {
        container.appendChild(App.el('div', { className: 'page-header' }, [
            App.el('h1', { className: 'page-title', textContent: 'Pause Groups' }),
            App.el('button', {
                className: 'btn btn-primary',
                textContent: '+ New Group',
                onClick: () => { window.location.hash = '#/groups/new'; }
            })
        ]));

        const listEl = App.el('div', { id: 'groups-list' });
        listEl.appendChild(App.loading());
        container.appendChild(listEl);

        try {
            const data = await API.get('groups');
            listEl.innerHTML = '';
            const groups = data.groups || [];

            if (groups.length === 0) {
                listEl.appendChild(App.emptyState('\u25CB', 'No pause groups yet.', App.el('button', {
                    className: 'btn btn-primary', textContent: 'Create First Group',
                    onClick: () => { window.location.hash = '#/groups/new'; }
                })));
                return;
            }

            groups.forEach(group => {
                const state = group.effective_state || 'empty';
                const stats = group.game_stats || {};
                const isActive = group.is_active == 1;

                // Build state badge for active groups
                const stateBadge = isActive && state !== 'empty'
                    ? App.el('span', {
                        className: 'badge badge-' + (state === 'enabled' ? 'enabled' : state === 'paused' ? 'paused' : 'info'),
                        textContent: state === 'enabled' ? 'Running' : state === 'paused' ? 'Paused' : 'Mixed'
                    }) : null;

                // Quick action buttons (only for active groups with games)
                const quickActions = isActive && state !== 'empty'
                    ? App.el('div', { className: 'flex gap-sm', style: { marginLeft: '0.75rem' } }, [
                        state !== 'enabled' ? App.el('button', {
                            className: 'btn btn-sm btn-success',
                            textContent: 'Unpause',
                            onClick: (e) => { e.stopPropagation(); quickAction(group.id, 'unpause', group.name, listEl); }
                        }) : null,
                        state !== 'paused' ? App.el('button', {
                            className: 'btn btn-sm btn-warning',
                            textContent: 'Pause',
                            onClick: (e) => { e.stopPropagation(); quickAction(group.id, 'pause', group.name, listEl); }
                        }) : null
                    ].filter(Boolean)) : null;

                const card = App.el('div', { className: 'card', style: { marginBottom: '0.75rem', cursor: 'pointer' },
                    onClick: () => { window.location.hash = '#/groups/' + group.id; }
                }, [
                    App.el('div', { className: 'flex-between' }, [
                        App.el('div', { style: { flex: '1', minWidth: '0' } }, [
                            App.el('div', { className: 'flex-center gap-sm' }, [
                                App.el('span', { className: 'status-dot status-dot-' + (isActive ? state : 'empty') }),
                                App.el('span', { className: 'card-title', textContent: group.name }),
                                App.el('span', { className: 'badge ' + (isActive ? 'badge-active' : 'badge-inactive'),
                                    textContent: isActive ? 'Active' : 'Inactive' }),
                                stateBadge
                            ].filter(Boolean)),
                            group.description ? App.el('p', { className: 'text-sm text-secondary mt-1', textContent: group.description }) : null
                        ].filter(Boolean)),
                        App.el('div', { className: 'flex-center' }, [
                            App.el('div', { className: 'text-sm text-secondary', style: { textAlign: 'right' } }, [
                                App.el('div', { textContent: (group.category_count || 0) + ' categories, ' + (stats.total || group.game_count || 0) + ' games' }),
                                App.el('div', { textContent: (group.schedule_count || 0) + ' schedules' })
                            ]),
                            quickActions
                        ].filter(Boolean))
                    ])
                ]);
                listEl.appendChild(card);
            });
        } catch (err) {
            listEl.innerHTML = '';
            App.toast(err.message, 'error');
        }
    }

    async function renderGroupForm(container, params) {
        const isEdit = params.id && params.id !== 'new';
        const groupId = isEdit ? params.id : null;

        container.appendChild(App.el('div', { className: 'page-header' }, [
            App.el('div', {}, [
                App.el('h1', { className: 'page-title', textContent: isEdit ? 'Edit Group' : 'New Group' }),
                App.el('p', { className: 'page-subtitle', textContent: isEdit ? 'Modify group configuration' : 'Create a new pause group' })
            ]),
            App.el('button', {
                className: 'btn btn-ghost', textContent: '\u2190 Back',
                onClick: () => { window.location.hash = '#/groups'; }
            })
        ]));

        const formWrap = App.el('div', { className: 'card' });
        formWrap.appendChild(App.loading());
        container.appendChild(formWrap);

        try {
            // Load data in parallel
            const promises = [API.get('games'), API.get('games/categories')];
            if (isEdit) promises.push(API.get('groups/' + groupId));
            const results = await Promise.all(promises);

            const allGames = results[0].games || [];
            const allCategories = results[1].categories || [];
            const existing = isEdit ? results[2] : null;

            formWrap.innerHTML = '';
            renderForm(formWrap, allGames, allCategories, existing, groupId);
        } catch (err) {
            formWrap.innerHTML = '';
            App.toast(err.message, 'error');
        }
    }

    function renderForm(container, allGames, allCategories, existing, groupId) {
        const selectedCategories = new Set((existing?.categories || []).map(c => c.category_id));
        const selectedGames = new Set((existing?.games || []).map(g => g.game_id));

        // Name
        const nameInput = App.el('input', { className: 'form-input', type: 'text', value: existing?.name || '', placeholder: 'e.g., Redemption Games' });
        container.appendChild(App.el('div', { className: 'form-group' }, [
            App.el('label', { className: 'form-label', textContent: 'Group Name' }),
            nameInput
        ]));

        // Description
        const descInput = App.el('textarea', { className: 'form-textarea', placeholder: 'Optional description...' });
        descInput.value = existing?.description || '';
        container.appendChild(App.el('div', { className: 'form-group' }, [
            App.el('label', { className: 'form-label', textContent: 'Description' }),
            descInput
        ]));

        // Active toggle
        const activeCheck = App.el('input', { type: 'checkbox', className: 'toggle-input', id: 'group-active' });
        activeCheck.checked = existing ? !!existing.is_active : true;
        container.appendChild(App.el('div', { className: 'form-group' }, [
            App.el('label', { className: 'toggle-label', for: 'group-active' }, [
                activeCheck,
                App.el('span', { className: 'toggle-switch' }),
                App.el('span', { textContent: 'Active' })
            ])
        ]));

        // Categories
        container.appendChild(App.el('div', { className: 'form-group' }, [
            App.el('label', { className: 'form-label', textContent: 'Categories' }),
            App.el('p', { className: 'form-help', textContent: 'All games in selected categories will be included in this group.' })
        ]));

        const catList = App.el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' } });
        allCategories.forEach(cat => {
            const cb = App.el('input', { type: 'checkbox', value: String(cat.id) });
            cb.checked = selectedCategories.has(cat.id);
            cb.addEventListener('change', () => {
                if (cb.checked) selectedCategories.add(cat.id);
                else selectedCategories.delete(cat.id);
            });
            catList.appendChild(App.el('label', { className: 'checkbox-label' }, [
                cb,
                App.el('span', { textContent: cat.name + ' (' + (cat.numberOfGames || 0) + ')' })
            ]));
        });
        if (allCategories.length === 0) {
            catList.appendChild(App.el('p', { className: 'text-muted text-sm', textContent: 'No categories available. Sync games first.' }));
        }
        container.appendChild(catList);

        // Individual games
        container.appendChild(App.el('div', { className: 'form-group mt-2' }, [
            App.el('label', { className: 'form-label', textContent: 'Individual Games' }),
            App.el('p', { className: 'form-help', textContent: 'Select specific games not covered by categories above.' })
        ]));

        const gameSearch = App.el('input', {
            className: 'form-input', type: 'text', placeholder: 'Search games...',
            style: { marginBottom: '0.5rem' }
        });
        container.appendChild(gameSearch);

        const gameListEl = App.el('div', { className: 'dual-pane-list', id: 'game-picker' });
        container.appendChild(gameListEl);

        function renderGamePicker() {
            gameListEl.innerHTML = '';
            const filter = gameSearch.value.toLowerCase();
            const sorted = [...allGames].sort((a, b) => a.game_name.localeCompare(b.game_name));
            const filtered = filter ? sorted.filter(g => g.game_name.toLowerCase().includes(filter)) : sorted;

            filtered.forEach(game => {
                const cb = App.el('input', { type: 'checkbox', value: game.game_id });
                cb.checked = selectedGames.has(game.game_id);
                cb.addEventListener('change', () => {
                    if (cb.checked) selectedGames.add(game.game_id);
                    else selectedGames.delete(game.game_id);
                });
                gameListEl.appendChild(App.el('label', { className: 'checkbox-label' }, [
                    cb,
                    App.el('span', { textContent: game.game_name }),
                    App.el('span', { className: 'text-xs text-muted', style: { marginLeft: 'auto' }, textContent: game.operation_status })
                ]));
            });

            if (filtered.length === 0) {
                gameListEl.appendChild(App.el('p', { className: 'text-muted text-sm', style: { padding: '0.5rem' }, textContent: 'No games found.' }));
            }
        }

        gameSearch.addEventListener('input', renderGamePicker);
        renderGamePicker();

        // Actions
        const saveBtn = App.el('button', { className: 'btn btn-primary', textContent: groupId ? 'Save Changes' : 'Create Group' });
        const deleteBtn = groupId ? App.el('button', { className: 'btn btn-danger', textContent: 'Delete', onClick: async () => {
            const yes = await App.confirm('Delete this group and all its schedules and overrides?');
            if (!yes) return;
            try {
                await API.del('groups/' + groupId);
                App.toast('Group deleted.', 'success');
                window.location.hash = '#/groups';
            } catch (err) { App.toast(err.message, 'error'); }
        }}) : null;

        const actions = App.el('div', { className: 'form-actions' }, [saveBtn, deleteBtn].filter(Boolean));
        container.appendChild(actions);

        saveBtn.addEventListener('click', async () => {
            const name = nameInput.value.trim();
            if (!name) { App.toast('Name is required.', 'error'); return; }

            const body = {
                name: name,
                description: descInput.value.trim(),
                is_active: activeCheck.checked ? 1 : 0,
                category_ids: Array.from(selectedCategories),
                game_ids: Array.from(selectedGames)
            };

            saveBtn.disabled = true;
            try {
                if (groupId) {
                    await API.put('groups/' + groupId, body);
                    App.toast('Group updated.', 'success');
                } else {
                    await API.post('groups', body);
                    App.toast('Group created.', 'success');
                }
                window.location.hash = '#/groups';
            } catch (err) {
                App.toast(err.message, 'error');
                saveBtn.disabled = false;
            }
        });
    }

    async function quickAction(groupId, action, groupName, listEl) {
        const verb = action === 'pause' ? 'Pause' : 'Unpause';
        const confirmed = await App.confirm(verb + ' all games in "' + groupName + '"?');
        if (!confirmed) return;

        // Disable all quick-action buttons
        listEl.querySelectorAll('.btn-success, .btn-warning').forEach(b => { b.disabled = true; });

        try {
            const result = await API.post('groups/' + groupId + '/' + action);
            const changed = result.changed || 0;
            const errors = result.errors || 0;

            if (errors > 0) {
                App.toast(verb + ' partially failed: ' + changed + ' changed, ' + errors + ' error(s).', 'warning');
            } else if (changed > 0) {
                App.toast(groupName + ': ' + changed + ' game' + (changed !== 1 ? 's' : '') + ' ' + action + 'd.', 'success');
            } else {
                App.toast(groupName + ': all games already ' + action + 'd.', 'info');
            }

            // Reload group list to reflect new state
            const data = await API.get('groups');
            listEl.innerHTML = '';
            const groups = data.groups || [];
            groups.forEach(group => {
                const state = group.effective_state || 'empty';
                const stats = group.game_stats || {};
                const isActive = group.is_active == 1;

                const stateBadge = isActive && state !== 'empty'
                    ? App.el('span', {
                        className: 'badge badge-' + (state === 'enabled' ? 'enabled' : state === 'paused' ? 'paused' : 'info'),
                        textContent: state === 'enabled' ? 'Running' : state === 'paused' ? 'Paused' : 'Mixed'
                    }) : null;

                const quickActions = isActive && state !== 'empty'
                    ? App.el('div', { className: 'flex gap-sm', style: { marginLeft: '0.75rem' } }, [
                        state !== 'enabled' ? App.el('button', {
                            className: 'btn btn-sm btn-success',
                            textContent: 'Unpause',
                            onClick: (e) => { e.stopPropagation(); quickAction(group.id, 'unpause', group.name, listEl); }
                        }) : null,
                        state !== 'paused' ? App.el('button', {
                            className: 'btn btn-sm btn-warning',
                            textContent: 'Pause',
                            onClick: (e) => { e.stopPropagation(); quickAction(group.id, 'pause', group.name, listEl); }
                        }) : null
                    ].filter(Boolean)) : null;

                const card = App.el('div', { className: 'card', style: { marginBottom: '0.75rem', cursor: 'pointer' },
                    onClick: () => { window.location.hash = '#/groups/' + group.id; }
                }, [
                    App.el('div', { className: 'flex-between' }, [
                        App.el('div', { style: { flex: '1', minWidth: '0' } }, [
                            App.el('div', { className: 'flex-center gap-sm' }, [
                                App.el('span', { className: 'status-dot status-dot-' + (isActive ? state : 'empty') }),
                                App.el('span', { className: 'card-title', textContent: group.name }),
                                App.el('span', { className: 'badge ' + (isActive ? 'badge-active' : 'badge-inactive'),
                                    textContent: isActive ? 'Active' : 'Inactive' }),
                                stateBadge
                            ].filter(Boolean)),
                            group.description ? App.el('p', { className: 'text-sm text-secondary mt-1', textContent: group.description }) : null
                        ].filter(Boolean)),
                        App.el('div', { className: 'flex-center' }, [
                            App.el('div', { className: 'text-sm text-secondary', style: { textAlign: 'right' } }, [
                                App.el('div', { textContent: (group.category_count || 0) + ' categories, ' + (stats.total || group.game_count || 0) + ' games' }),
                                App.el('div', { textContent: (group.schedule_count || 0) + ' schedules' })
                            ]),
                            quickActions
                        ].filter(Boolean))
                    ])
                ]);
                listEl.appendChild(card);
            });
        } catch (err) {
            App.toast(verb + ' failed: ' + err.message, 'error');
            listEl.querySelectorAll('.btn-success, .btn-warning').forEach(b => { b.disabled = false; });
        }
    }
})();

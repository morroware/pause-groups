/**
 * Override management: active/upcoming/expired sections, create, delete.
 */
(function() {
    App.registerRoute('#/overrides', { render: renderOverrides });

    async function renderOverrides(container) {
        container.appendChild(App.el('div', { className: 'page-header' }, [
            App.el('h1', { className: 'page-title', textContent: 'Schedule Overrides' }),
            App.el('button', {
                className: 'btn btn-primary', textContent: '+ New Override',
                onClick: showCreateForm
            })
        ]));

        const content = App.el('div', { id: 'overrides-content' });
        content.appendChild(App.loading());
        container.appendChild(content);

        await loadOverrides();
    }

    async function loadOverrides() {
        const content = document.getElementById('overrides-content');
        if (!content) return;

        try {
            const data = await API.get('overrides');
            content.innerHTML = '';
            renderSection(content, 'Active Now', data.active || [], 'badge-active');
            renderSection(content, 'Upcoming', data.upcoming || [], 'badge-info');
            renderSection(content, 'Expired', data.expired || [], 'badge-inactive');
        } catch (err) {
            content.innerHTML = '';
            App.toast(err.message, 'error');
        }
    }

    function renderSection(container, title, overrides, badgeCls) {
        const section = App.el('div', { className: 'override-section' });
        section.appendChild(App.el('div', { className: 'override-section-title' }, [
            App.el('span', { textContent: title }),
            App.el('span', { className: 'badge ' + badgeCls, textContent: String(overrides.length) })
        ]));

        if (overrides.length === 0) {
            section.appendChild(App.el('p', { className: 'text-muted text-sm', style: { padding: '0.5rem 0' }, textContent: 'None.' }));
        } else {
            overrides.forEach(o => {
                const card = App.el('div', { className: 'override-card' }, [
                    App.el('div', { className: 'override-info' }, [
                        App.el('div', { className: 'flex-center gap-sm' }, [
                            App.el('span', { className: 'override-name', textContent: o.name }),
                            App.el('span', { className: 'badge ' + (o.action === 'pause' ? 'badge-paused' : 'badge-enabled'), textContent: o.action })
                        ]),
                        App.el('div', { className: 'override-meta' }, [
                            App.el('span', { textContent: (o.group_name || 'Group') + ' \u2022 ' }),
                            App.el('span', { textContent: App.formatDatetime(o.start_datetime) + ' \u2014 ' + App.formatDatetime(o.end_datetime) }),
                            o.created_by_name ? App.el('span', { textContent: ' \u2022 by ' + o.created_by_name }) : null
                        ].filter(Boolean))
                    ]),
                    App.el('div', { className: 'flex gap-sm' }, [
                        title === 'Active Now' ? App.el('span', { className: 'override-countdown', textContent: 'ends ' + App.formatRelative(o.end_datetime) }) : null,
                        title !== 'Expired' ? App.el('button', {
                            className: 'btn btn-ghost btn-sm text-danger', textContent: 'Delete',
                            onClick: () => deleteOverride(o.id, title === 'Active Now')
                        }) : null
                    ].filter(Boolean))
                ]);
                section.appendChild(card);
            });
        }

        container.appendChild(section);
    }

    async function showCreateForm() {
        try {
            const groupData = await API.get('groups');
            const groups = groupData.groups || [];

            if (groups.length === 0) {
                App.toast('Create a pause group first.', 'warning');
                return;
            }

            const form = App.el('div');

            // Group selector
            const groupSelect = App.el('select', { className: 'form-select' });
            groups.forEach(g => {
                groupSelect.appendChild(App.el('option', { value: String(g.id), textContent: g.name }));
            });
            form.appendChild(App.el('div', { className: 'form-group' }, [
                App.el('label', { className: 'form-label', textContent: 'Pause Group' }),
                groupSelect
            ]));

            // Name
            const nameInput = App.el('input', { className: 'form-input', type: 'text', placeholder: 'e.g., Birthday Party Override' });
            form.appendChild(App.el('div', { className: 'form-group' }, [
                App.el('label', { className: 'form-label', textContent: 'Override Name' }),
                nameInput
            ]));

            // Action
            const actionSelect = App.el('select', { className: 'form-select' });
            actionSelect.appendChild(App.el('option', { value: 'unpause', textContent: 'Unpause \u2014 Force games ON (override a pause schedule)' }));
            actionSelect.appendChild(App.el('option', { value: 'pause', textContent: 'Pause \u2014 Force games OFF (e.g., maintenance)' }));
            form.appendChild(App.el('div', { className: 'form-group' }, [
                App.el('label', { className: 'form-label', textContent: 'Action' }),
                actionSelect
            ]));

            // Datetime range
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const nowStr = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

            const startInput = App.el('input', { className: 'form-input', type: 'text', value: nowStr, placeholder: 'YYYY-MM-DD HH:MM' });
            const endInput = App.el('input', { className: 'form-input', type: 'text', placeholder: 'YYYY-MM-DD HH:MM' });
            form.appendChild(App.el('div', { className: 'form-row' }, [
                App.el('div', { className: 'form-group' }, [App.el('label', { className: 'form-label', textContent: 'Start (YYYY-MM-DD HH:MM)' }), startInput]),
                App.el('div', { className: 'form-group' }, [App.el('label', { className: 'form-label', textContent: 'End (YYYY-MM-DD HH:MM)' }), endInput])
            ]));

            const footer = App.el('div', { className: 'flex gap-sm' }, [
                App.el('button', { className: 'btn btn-secondary', textContent: 'Cancel', onClick: () => App.hideModal() }),
                App.el('button', { className: 'btn btn-primary', textContent: 'Create Override', onClick: async () => {
                    const name = nameInput.value.trim();
                    if (!name) { App.toast('Name is required.', 'error'); return; }
                    if (!startInput.value || !endInput.value) { App.toast('Both start and end times are required.', 'error'); return; }

                    try {
                        await API.post('overrides', {
                            pause_group_id: parseInt(groupSelect.value),
                            name: name,
                            action: actionSelect.value,
                            start_datetime: startInput.value.trim(),
                            end_datetime: endInput.value.trim()
                        });
                        App.hideModal();
                        App.toast('Override created.', 'success');
                        await loadOverrides();
                    } catch (err) { App.toast(err.message, 'error'); }
                }})
            ]);

            App.showModal('New Override', form, footer);
        } catch (err) {
            App.toast(err.message, 'error');
        }
    }

    async function deleteOverride(id, isActive) {
        const msg = isActive
            ? 'Delete this active override? Games will revert to their scheduled state.'
            : 'Delete this override?';
        const yes = await App.confirm(msg);
        if (!yes) return;
        try {
            await API.del('overrides/' + id);
            App.toast('Override deleted.', 'success');
            await loadOverrides();
        } catch (err) { App.toast(err.message, 'error'); }
    }
})();

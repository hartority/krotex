'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require krotex.sections as sections';
'require krotex.connections as connections';

var callStatus = rpc.declare({
	object: 'krotex',
	method: 'status',
	expect: { '': {} }
});

var callAction = rpc.declare({
	object: 'krotex',
	method: 'action',
	params: [ 'action' ],
	expect: { '': {} }
});

var callDevices = rpc.declare({ object: 'krotex', method: 'devices', expect: { '': {} } });
var callRouting = rpc.declare({ object: 'krotex', method: 'routing', expect: { '': {} } });
var callSaveSettings = rpc.declare({ object: 'krotex', method: 'save_settings', params: [ 'sections', 'routing' ], expect: { '': {} } });

return view.extend({
	load: function() {
		return callStatus().catch(function() {
			return { available: false };
		});
	},

	refresh: function() {
		return callStatus().then(L.bind(function(data) {
			this.updateStatus(data);
			return this.refreshRouting();
		}, this)).catch(L.bind(function() {
			this.updateStatus({ available: false });
		}, this));
	},

	refreshRouting: function(force) {
		var revision = this.routingRevision || 0;
		return callRouting().then(L.bind(function(data) {
			if (revision !== (this.routingRevision || 0)) return;
			if (data.code) throw new Error(data.message);
			this.routingStatus = data;
			if (force || !this.routingLoaded || !this.routingDirty) {
				this.routingMacs = (data.macs || (data.enabled && data.mac ? [ data.mac ] : [])).slice();
				this.savedRoutingMacs = this.routingMacs.slice();
				this.savedRoutingMode = data.mode || 'selected';
				this.routingMode.value = this.savedRoutingMode;
				this.routingDirty = false;
			}
			this.routingLoaded = true;
			this.updateRoutingDraft();
		}, this)).catch(L.bind(function(error) {
			this.routingSummary.textContent = _('Device routing status unavailable');
			if (force) throw error;
		}, this));
	},

	updateRoutingDraft: function() {
		var all = this.routingMode.value === 'all';
		this.routingDirty = this.routingMode.value !== this.savedRoutingMode || JSON.stringify(this.routingMacs) !== JSON.stringify(this.savedRoutingMacs || []);
		this.deviceSelection.style.display = all ? 'none' : '';
		this.allDevicesNotice.style.display = all ? '' : 'none';
		this.routingSummary.textContent = all ? _('All LAN devices') : _('Selected devices: %s').format(this.routingMacs.length);
		this.routingSummary.textContent += ' \u00b7 ' + (this.routingDirty ? _('Unsaved changes') : this.routingStatus && this.routingStatus.active ? _('Active') : _('Rules are inactive'));
		this.renderRoutingDevices();
	},

	handleSettingsSave: function() {
		if (this.busy || !this.routingLoaded || !L.hasViewPermission()) return Promise.resolve();
		var editor = this.sectionsEditor, serialized;
		try { serialized = JSON.stringify(editor.serialize()); }
		catch (error) { editor.result.textContent = error.message; return Promise.resolve(); }
		this.routingRevision = (this.routingRevision || 0) + 1;
		this.busy = true;
		this.updateStatus(this.lastStatus);
		editor.result.textContent = _('Applying settings...');
		return callSaveSettings(serialized, JSON.stringify({ mode: this.routingMode.value, macs: this.routingMacs })).then(L.bind(function(result) {
			if (result.code !== 0) throw new Error(result.message || _('Unable to apply settings.'));
			return Promise.all([ editor.load(), this.refreshRouting(true) ]).then(function() {
				editor.result.textContent = _('Settings saved and applied.');
			});
		}, this)).catch(function(error) {
			editor.result.textContent = error.message;
			ui.addNotification(null, E('p', {}, error.message));
		}).then(L.bind(function() {
			this.busy = false;
			this.updateStatus(this.lastStatus);
		}, this));
	},

	handleSettingsReset: function() {
		if (this.busy || !this.routingLoaded || !L.hasViewPermission()) return Promise.resolve();
		this.routingRevision = (this.routingRevision || 0) + 1;
		this.busy = true;
		this.updateStatus(this.lastStatus);
		return Promise.all([ this.sectionsEditor.load(), this.refreshRouting(true) ]).then(L.bind(function() {
			this.sectionsEditor.result.textContent = '';
			this.routingMac.value = '';
			this.deviceSelect.value = '';
		}, this)).catch(L.bind(function(error) {
			this.sectionsEditor.result.textContent = error.message;
		}, this)).then(L.bind(function() {
			this.busy = false;
			this.updateStatus(this.lastStatus);
		}, this));
	},

	renderRoutingDevices: function() {
		this.routingRemoveButtons = [];
		var rows = (this.routingMacs || []).map(L.bind(function(mac) {
			var device = (this.devices || []).filter(function(item) { return item.mac.toLowerCase() === mac; })[0];
			var name = device && device.name !== '*' ? device.name : _('Unnamed device');
			var remove = E('button', {
				'class': 'btn cbi-button-negative', 'type': 'button', 'title': _('Remove device'),
				'aria-label': _('Remove device %s').format(mac),
				'click': ui.createHandlerFn(this, 'handleRemoveDevice', mac)
			}, '×');
			this.routingRemoveButtons.push(remove);
			var details = [ E('code', { 'style': 'color:inherit;background:none;padding:0;font-size:.9em;white-space:normal;overflow-wrap:anywhere' }, mac) ];
			if (device) details.unshift(E('span', { 'style': 'font-size:.9em' }, device.address));
			return E('li', { 'style': 'display:flex;align-items:center;justify-content:space-between;gap:1em;padding:.8em 1em;margin:.6em 0;border:1px solid #409eff66;border-radius:8px;background:rgba(64,158,255,.08);color:inherit' }, [
				E('div', { 'style': 'min-width:0;flex:1;color:inherit' }, [
					E('strong', { 'style': 'display:block;color:inherit;font-size:1em;margin-bottom:.3em;overflow-wrap:anywhere' }, name),
					E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:.2em 1em;color:inherit' }, details)
				]), remove
			]);
		}, this));
		this.routingList.replaceChildren.apply(this.routingList, rows.length ? rows : [ E('li', { 'style': 'padding:1em;border:1px dashed #8886;border-radius:8px;color:inherit' }, _('No devices added')) ]);
		this.updateStatus(this.lastStatus);
	},

	handleRoutingMode: function() {
		if (this.busy || !this.routingLoaded || !L.hasViewPermission()) return Promise.resolve();
		if ([ 'all', 'selected' ].indexOf(this.routingMode.value) === -1) return Promise.resolve();
		this.routingRevision = (this.routingRevision || 0) + 1;
		this.updateRoutingDraft();
		return Promise.resolve();
	},

	handleRemoveDevice: function(mac) {
		return this.handleRouting(false, mac);
	},

	refreshDevices: function() {
		return callDevices().then(L.bind(function(data) {
			this.devices = data.devices || [];
			if (this.sectionsEditor && this.sectionsEditor.setDevices) this.sectionsEditor.setDevices(this.devices);
			var options = [ E('option', { 'value': '' }, _('Select a DHCP device')) ];
			(data.devices || []).forEach(function(device) {
				options.push(E('option', { 'value': device.mac }, '%s · %s · %s'.format(
					device.name === '*' ? _('Unnamed device') : device.name, device.address, device.mac)));
			});
			this.deviceSelect.replaceChildren.apply(this.deviceSelect, options);
			this.renderRoutingDevices();
		}, this)).catch(function(error) {
			ui.addNotification(null, E('p', {}, _('Unable to load DHCP devices. Enter the MAC address manually.')));
		});
	},

	handleRouting: function(enabled, selectedMac) {
		if (this.busy || !this.routingLoaded || !L.hasViewPermission())
			return Promise.resolve();
		var mac = (selectedMac || this.routingMac.value).trim().toLowerCase();
		if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || mac === '00:00:00:00:00:00' || (parseInt(mac.slice(0, 2), 16) & 1)) {
			ui.addNotification(null, E('p', {}, _('Enter a valid device MAC address.')));
			return Promise.resolve();
		}
		var macs = this.routingMacs.filter(function(item) { return item !== mac; });
		if (enabled) {
			if (this.routingMacs.indexOf(mac) >= 0) return Promise.resolve();
			if (macs.length >= 128) {
				ui.addNotification(null, E('p', {}, _('A maximum of 128 devices is supported.')));
				return Promise.resolve();
			}
			macs.push(mac);
			this.routingMac.value = '';
			this.deviceSelect.value = '';
		}
		this.routingMacs = macs;
		this.routingRevision = (this.routingRevision || 0) + 1;
		this.updateRoutingDraft();
		return Promise.resolve();
	},

	updateStatus: function(data) {
		this.lastStatus = data;
		var available = data.available === true;
		var running = available && data.running === true;
		var seconds = Number(data.uptime) || 0;
		var duration = '%s:%s:%s'.format(
			String(Math.floor(seconds / 3600)).padStart(2, '0'),
			String(Math.floor(seconds / 60) % 60).padStart(2, '0'),
			String(seconds % 60).padStart(2, '0'));

		this.fields.status.textContent = !available ? _('Status unavailable')
			: !data.installed ? _('Xray-core is not installed')
			: running ? _('Running') : _('Stopped');
		this.fields.status.style.color = !available ? '' : running ? '#22863a' : '#b42318';
		this.fields.enabled.textContent = available ? (data.enabled ? _('Enabled') : _('Disabled')) : '—';
		this.autostartButton.textContent = !available ? _('Autostart unavailable') : data.enabled ? _('Disable autostart') : _('Enable autostart');
		this.fields.pid.textContent = running ? String(data.pid) : '—';
		this.fields.krotex_version.textContent = available && data.krotex_version ? data.krotex_version : '\u2014';
		this.fields.core_version.textContent = available && data.core_version ? data.core_version : '—';
		this.fields.uptime.textContent = running ? duration : '—';
		this.fields.memory.textContent = running ? '%.1f MiB'.format((Number(data.memory_kib) || 0) / 1024) : '—';
		this.fields.updated.textContent = available ? new Date().toLocaleTimeString() : '—';

		this.buttons.concat(this.routingRemoveButtons || []).forEach(L.bind(function(button) {
			button.disabled = !!this.busy || !available || !L.hasViewPermission();
		}, this));
		this.routingMac.disabled = !!this.busy || !this.routingLoaded || !available || !L.hasViewPermission();
		this.deviceSelect.disabled = this.routingMac.disabled;
		this.routingMode.disabled = this.routingMac.disabled;
		if (this.connectionChecker) this.connectionChecker.setState(!!this.busy, available);
		if (this.sectionsEditor) this.sectionsEditor.setState(!!this.busy || !this.routingLoaded, available);
	},

	handleAction: function(action) {
		if (this.busy)
			return Promise.resolve();
		this.busy = true;
		this.updateStatus(this.lastStatus);
		return callAction(action).then(function(result) {
			if (result.code !== 0)
				throw new Error(_('Service command failed. Check the system log.'));
		}).catch(function(error) {
			ui.addNotification(null, E('p', {}, error.message));
		}).then(L.bind(function() {
			this.busy = false;
			return this.refresh();
		}, this));
	},

	showTab: function(name, focus) {
		if (!this.tabPanels[name]) return;
		this.activeTab = name;
		if (this.connectionChecker) this.connectionChecker.setVisible(name === 'overview');
		Object.keys(this.tabPanels).forEach(L.bind(function(key) {
			var selected = key === name;
			this.tabPanels[key].style.display = selected ? '' : 'none';
			this.tabButtons[key].setAttribute('aria-selected', String(selected));
			this.tabButtons[key].tabIndex = selected ? 0 : -1;
			this.tabItems[key].className = selected ? 'cbi-tab' : 'cbi-tab-disabled';
		}, this));
		if (focus) this.tabButtons[name].focus();
		if (name !== 'overview' && this.sectionsEditor.fitLinks) this.sectionsEditor.fitLinks();
	},

	render: function(data) {
		this.fields = {};
		this.buttons = [];
		this.routingMacs = [];
		this.savedRoutingMacs = [];
		this.routingDirty = false;
		this.routingLoaded = false;
		this.devices = [];
		this.routingList = E('ul', { 'style': 'list-style:none;padding:0;margin:1em 0;color:inherit' }, []);
		this.savedRoutingMode = 'selected';
		this.routingMode = E('select', { 'class': 'cbi-input-select', 'aria-label': _('Device routing mode'),
			'change': ui.createHandlerFn(this, 'handleRoutingMode')
		}, [ E('option', { 'value': 'selected' }, _('Selected devices')), E('option', { 'value': 'all' }, _('All LAN devices')) ]);
		this.routingMode.value = 'selected';
		this.allDevicesNotice = E('div', { 'style': 'display:none;margin:1em 0;padding:1em;border:1px solid #409eff66;border-radius:8px;background:rgba(64,158,255,.08)' },
			_('All devices in the LAN firewall zone follow the routing sections, including newly connected devices. Your selected-device list is preserved.'));
		this.routingSummary = E('p', { 'style': 'margin:.75em 0 1em' }, _('Loading device routing…'));
		this.routingMac = E('input', {
			'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'aa:bb:cc:dd:ee:ff',
			'aria-label': _('Device MAC address'), 'autocomplete': 'off', 'spellcheck': 'false'
		});
		this.deviceSelect = E('select', {
			'class': 'cbi-input-select', 'aria-label': _('Device'),
			'change': L.bind(function() {
				if (this.deviceSelect.value) {
					return this.handleRouting(true, this.deviceSelect.value);
				}
			}, this)
		}, []);
		var routingButtons = [ [ true, _('Add device') ] ].map(L.bind(function(action) {
			var button = E('button', {
				'class': 'btn cbi-button-action', 'style': 'margin:.5em .5em .5em 0',
				'click': ui.createHandlerFn(this, 'handleRouting', action[0])
			}, action[1]);
			this.buttons.push(button);
			return button;
		}, this));
		var refreshDevices = E('button', {
			'class': 'btn cbi-button-action', 'style': 'margin:.5em .5em',
			'click': ui.createHandlerFn(this, 'refreshDevices')
		}, _('Refresh devices'));
		this.buttons.push(refreshDevices);
		this.deviceSelection = E('div', {}, [
			E('p', {}, _('Select a device to add it, or enter its MAC address and click Add device.')),
			E('div', { 'style': 'display:flex;align-items:center;flex-wrap:wrap;gap:.5em' }, [ this.deviceSelect, refreshDevices ]),
			E('div', { 'style': 'display:flex;align-items:center;flex-wrap:wrap;gap:.5em' }, [ this.routingMac ].concat(routingButtons)),
			this.routingList
		]);
		var actions = [
			[ 'start', _('Start') ], [ 'stop', _('Stop') ], [ 'restart', _('Restart') ]
		].map(L.bind(function(action) {
			var button = E('button', { 'class': 'btn cbi-button-action', 'type': 'button', 'style': 'margin:0',
				'click': ui.createHandlerFn(this, 'handleAction', action[0]) }, action[1]);
			this.buttons.push(button);
			return button;
		}, this));
		var actionStyle = 'display:flex;align-items:center;flex-wrap:wrap;gap:.5em;max-width:100%';
		this.serviceActions = E('div', { 'aria-label': _('Service controls'), 'style': actionStyle }, actions);
		this.autostartButton = E('button', { 'class': 'btn cbi-button-action', 'type': 'button', 'style': 'margin:0',
			'click': L.bind(function() {
				if (!this.lastStatus.available || !L.hasViewPermission()) return Promise.resolve();
				return this.handleAction(this.lastStatus.enabled ? 'disable' : 'enable');
			}, this)
		}, _('Enable autostart'));
		this.buttons.push(this.autostartButton);
		this.autostartActions = E('div', { 'aria-label': _('Autostart controls'), 'style': actionStyle }, [ this.autostartButton ]);
		var rows = [
			[ 'status', _('Status') ], [ 'enabled', _('Autostart') ],
			[ 'krotex_version', _('Krotex version') ], [ 'core_version', _('Xray version') ],
			[ 'pid', _('PID') ], [ 'uptime', _('Uptime') ], [ 'memory', _('Memory') ], [ 'updated', _('Updated') ]
		].map(L.bind(function(row) {
			var controls = row[0] === 'status' ? [ this.serviceActions ] : row[0] === 'enabled' ? [ this.autostartActions ] : [];
			this.fields[row[0]] = E('span', { 'style': 'display:inline-block;font-weight:600;font-variant-numeric:tabular-nums' + (controls.length ? ';min-width:6em' : '') }, '\u2014');
			return E('div', { 'style': 'display:flex;align-items:center;flex-wrap:wrap;gap:.4em 1em;min-width:0' }, [
				E('dt', { 'style': 'display:block;float:none;flex:0 0 8em;margin:0;opacity:.75' }, row[1]),
				E('dd', { 'style': 'display:flex;align-items:center;flex-wrap:wrap;flex:1 1 18em;min-width:0;gap:.5em 1em;float:none;margin:0' }, [ this.fields[row[0]] ].concat(controls))
			]);
		}, this));
		this.statsPanel = E('dl', {
			'class': 'cbi-section', 'aria-label': _('Service statistics'), 'title': _('Status refreshes every 5 seconds.'),
			'style': 'display:flex;flex-direction:column;gap:.85em;padding:1em;margin:.5em 0 1em;border:1px solid #8884;border-radius:6px'
		}, rows);
		this.pageHeader = E('div', { 'style': 'margin-bottom:.75em' }, [ E('h3', { 'style': 'margin:0' }, _('Service overview')) ]);

		this.connectionChecker = connections.create({ onBusy: L.bind(function(busy) { this.busy = busy; this.updateStatus(this.lastStatus); }, this) });
		var connectionsPanel = this.connectionChecker.render();
		this.sectionsEditor = sections.create({
			onLoaded: L.bind(function() { this.connectionChecker.load(); }, this),
			externalActions: true,
			hasPendingChanges: L.bind(function() { return !!this.routingDirty; }, this),
			onSave: L.bind(this.handleSettingsSave, this),
			onReset: L.bind(this.handleSettingsReset, this),
			onBusy: L.bind(function(busy) { this.busy = busy; this.updateStatus(this.lastStatus); }, this),
			onApplied: L.bind(this.refresh, this)
		});
		this.sectionsEditor.render();
		this.tabPanels = {
			overview: E('section', { 'id': 'krotex-overview', 'role': 'tabpanel', 'aria-labelledby': 'krotex-tab-overview' }, [ this.pageHeader, this.statsPanel, connectionsPanel ]),
			default: E('section', { 'id': 'krotex-default', 'role': 'tabpanel', 'aria-labelledby': 'krotex-tab-default' }, [
				this.sectionsEditor.generalPanel,
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, _('Devices using default routing')),
					E('label', { 'style': 'display:block;margin-bottom:.5em' }, _('Apply routing sections to')),
					this.routingMode, this.routingSummary, this.allDevicesNotice, this.deviceSelection,
					E('p', {}, _('Public IPv4 TCP and UDP traffic follows the sections. Local IPv4 networks and router access remain direct. DNS uses 1.1.1.1 through the default or first enabled Xray section, or directly when none are enabled. Public IPv6 and IPv6 DNS are blocked for routed devices to prevent bypass.')),
					E('p', {}, _('Save and apply the changes below. Reconnect devices after applying routing changes. Stopping Krotex restores direct access.'))
				])
			]),
			devices: E('section', { 'id': 'krotex-devices', 'role': 'tabpanel', 'aria-labelledby': 'krotex-tab-devices' }, [ this.sectionsEditor.devicePanel ])
		};
		this.tabButtons = {};
		this.tabItems = {};
		var tabs = [ [ 'overview', _('Overview') ], [ 'default', _('Default routing') ], [ 'devices', _('Device routing') ] ];
		var tabBar = E('ul', { 'class': 'cbi-tabmenu', 'role': 'tablist', 'aria-label': _('Krotex pages'), 'style': 'display:flex;flex-wrap:wrap' }, tabs.map(L.bind(function(tab, index) {
			var link = E('a', { 'href': '#krotex-' + tab[0], 'id': 'krotex-tab-' + tab[0], 'role': 'tab', 'aria-controls': 'krotex-' + tab[0],
				'click': L.bind(function(event) { event.preventDefault(); this.showTab(tab[0]); }, this),
				'keydown': L.bind(function(event) {
					var target;
					if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
					else if (event.key === 'ArrowLeft') target = (index + tabs.length - 1) % tabs.length;
					else if (event.key === 'Home') target = 0;
					else if (event.key === 'End') target = tabs.length - 1;
					else return;
					event.preventDefault(); this.showTab(tabs[target][0], true);
				}, this)
			}, tab[1]);
			this.tabButtons[tab[0]] = link;
			var item = E('li', { 'role': 'presentation' }, [ link ]);
			this.tabItems[tab[0]] = item;
			return item;
		}, this)));
		var page = E('div', { 'style': 'padding-bottom:1.5em' }, [
			E('h2', {}, _('Krotex')), tabBar,
			this.tabPanels.overview, this.tabPanels.default, this.tabPanels.devices,
			E('div', { 'aria-label': _('Settings actions'), 'style': 'display:flex;align-items:center;flex-wrap:wrap;gap:.5em;margin-top:1em' }, [ this.sectionsEditor.saveButton, this.sectionsEditor.resetButton, this.sectionsEditor.result ])
		]);
		this.showTab('overview');
		this.updateStatus(data);
		this.refreshRouting();
		this.refreshDevices();
		poll.add(L.bind(this.refresh, this), 5);
		return page;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});

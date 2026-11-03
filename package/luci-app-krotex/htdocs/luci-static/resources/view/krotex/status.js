'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require krotex.vless as vless';

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

var callConnection = rpc.declare({ object: 'krotex', method: 'connection', expect: { '': {} } });
var callSaveConnection = rpc.declare({ object: 'krotex', method: 'save_connection', params: [ 'profile' ], expect: { '': {} } });
var callTestConnection = rpc.declare({ object: 'krotex', method: 'test_connection', expect: { '': {} } });
var callDevices = rpc.declare({ object: 'krotex', method: 'devices', expect: { '': {} } });
var callRouting = rpc.declare({ object: 'krotex', method: 'routing', expect: { '': {} } });
var callSetRouting = rpc.declare({ object: 'krotex', method: 'set_routing', params: [ 'mac', 'enabled' ], expect: { '': {} } });

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

	refreshRouting: function() {
		return callRouting().then(L.bind(function(data) {
			if (data.code) throw new Error(data.message);
			this.routingMacs = data.macs || (data.enabled && data.mac ? [ data.mac ] : []);
			this.routingSummary.textContent = !data.enabled ? _('Device routing is disabled')
				: data.active ? _('Active devices: %s').format(this.routingMacs.length)
				: _('Configured devices: %s; rules are inactive').format(this.routingMacs.length);
			if (data.active && !this.lastStatus.running)
				this.routingSummary.textContent += ' · ' + _('Xray is stopped');
			this.renderRoutingDevices();
		}, this)).catch(L.bind(function() {
			this.routingSummary.textContent = _('Device routing status unavailable');
		}, this));
	},

	renderRoutingDevices: function() {
		this.routingRemoveButtons = [];
		var rows = (this.routingMacs || []).map(L.bind(function(mac) {
			var device = (this.devices || []).filter(function(item) { return item.mac.toLowerCase() === mac; })[0];
			var label = device ? '%s · %s · %s'.format(device.name === '*' ? _('Unnamed device') : device.name, device.address, mac) : mac;
			var remove = E('button', {
				'class': 'btn cbi-button-negative', 'type': 'button', 'title': _('Remove device'),
				'aria-label': _('Remove device %s').format(mac),
				'click': ui.createHandlerFn(this, 'handleRemoveDevice', mac)
			}, '×');
			this.routingRemoveButtons.push(remove);
			return E('li', { 'style': 'display:flex;align-items:center;justify-content:space-between;gap:1em;margin:.5em 0' }, [ E('span', {}, label), remove ]);
		}, this));
		this.routingList.replaceChildren.apply(this.routingList, rows.length ? rows : [ E('li', {}, _('No devices added')) ]);
		this.updateStatus(this.lastStatus);
	},

	handleRemoveDevice: function(mac) {
		return this.handleRouting(false, mac);
	},

	refreshDevices: function() {
		return callDevices().then(L.bind(function(data) {
			this.devices = data.devices || [];
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
		if (this.busy)
			return Promise.resolve();
		var mac = (selectedMac || this.routingMac.value).trim().toLowerCase();
		if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
			ui.addNotification(null, E('p', {}, _('Enter a valid device MAC address.')));
			return Promise.resolve();
		}
		this.busy = true;
		this.updateStatus(this.lastStatus);
		this.routingResult.textContent = _('Applying device routing…');
		return callSetRouting(mac, enabled).then(L.bind(function(result) {
			if (result.code !== 0)
				throw new Error(result.message || _('Unable to apply device routing.'));
			this.routingResult.textContent = enabled ? _('Device added.') : _('Device removed.');
			if (enabled) {
				this.routingMac.value = '';
				this.deviceSelect.value = '';
			}
		}, this)).catch(L.bind(function(error) {
			this.routingResult.textContent = error.message;
			ui.addNotification(null, E('p', {}, error.message));
		}, this)).then(L.bind(function() {
			this.busy = false;
			return this.refresh();
		}, this));
	},

	refreshConnection: function() {
		return callConnection().then(L.bind(function(data) {
			this.connectionSummary.textContent = data.configured
				? '%s:%s · %s'.format(data.address, data.port, data.security.toUpperCase())
				: _('No VLESS connection configured');
			if (!this.connectionEdited && data.configured) {
				this.connectionInput.value = data.link || (data.profile ? vless.format(data.profile) : '');
				this.handleConnectionInput(false);
			}
		}, this)).catch(L.bind(function() {
			this.connectionSummary.textContent = _('Connection settings unavailable');
		}, this));
	},

	readConnection: function() {
		try {
			var result = vless.inspect(this.connectionInput.value);
			this.connectionWarning.textContent = result.ignored.length
				? _('Ignored parameters (not applied): %s').format(result.ignored.join(', ')) : '';
			result.profile.url = this.connectionInput.value.trim();
			return result.profile;
		}
		catch (error) {
			this.connectionWarning.textContent = error.message;
			throw error;
		}
	},

	handleConnectionInput: function(edited) {
		if (edited !== false) this.connectionEdited = true;
		setTimeout(L.bind(function() {
			this.connectionInput.style.height = 'auto';
			var border = (this.connectionInput.offsetHeight || 0) - (this.connectionInput.clientHeight || 0);
			this.connectionInput.style.height = Math.max(120, this.connectionInput.scrollHeight + border) + 'px';
		}, this), 0);
		if (!this.connectionInput.value.trim()) {
			this.connectionWarning.textContent = '';
			return;
		}
		try { this.readConnection(); }
		catch (error) { /* Validation errors are displayed below the link. */ }
	},

	handleConnection: function(action) {
		if (this.busy)
			return Promise.resolve();
		var profile;
		if (action === 'save') {
			try { profile = this.readConnection(); }
			catch (error) {
				ui.addNotification(null, E('p', {}, error.message));
				return Promise.resolve();
			}
		}
		this.busy = true;
		this.updateStatus(this.lastStatus);
		this.connectionResult.textContent = action === 'save' ? _('Applying connection…') : _('Checking connection…');
		return (action === 'save' ? callSaveConnection(JSON.stringify(profile)) : callTestConnection())
			.then(L.bind(function(result) {
				if (result.code !== 0)
					throw new Error(result.message || _('Connection operation failed.'));
				this.connectionResult.textContent = action === 'save' ? _('Connection saved and applied.')
					: _('Connection successful. Exit IP: %s').format(result.ip);
				if (action === 'save') this.connectionEdited = false;
			}, this)).catch(L.bind(function(error) {
				this.connectionResult.textContent = error.message;
				ui.addNotification(null, E('p', {}, error.message));
			}, this)).then(L.bind(function() {
				this.busy = false;
				return Promise.all([ this.refresh(), this.refreshConnection() ]);
			}, this));
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
		this.fields.pid.textContent = running ? String(data.pid) : '—';
		this.fields.core_version.textContent = available && data.core_version ? data.core_version : '—';
		this.fields.uptime.textContent = running ? duration : '—';
		this.fields.memory.textContent = running ? '%.1f MiB'.format((Number(data.memory_kib) || 0) / 1024) : '—';
		this.fields.updated.textContent = available ? new Date().toLocaleTimeString() : '—';

		this.buttons.concat(this.routingRemoveButtons || []).forEach(L.bind(function(button) {
			button.disabled = !!this.busy || !available || !L.hasViewPermission();
		}, this));
		this.connectionInput.disabled = !!this.busy || !available || !L.hasViewPermission();
		this.routingMac.disabled = this.connectionInput.disabled;
		this.deviceSelect.disabled = this.connectionInput.disabled;
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

	render: function(data) {
		this.fields = {};
		this.buttons = [];
		this.routingMacs = [];
		this.devices = [];
		this.routingList = E('ul', { 'style': 'list-style:none;padding:0' }, []);
		this.connectionEdited = false;
		this.routingSummary = E('p', {}, _('Loading device routing…'));
		this.routingResult = E('p', { 'role': 'status', 'aria-live': 'polite' }, '');
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
		this.connectionSummary = E('p', {}, _('Loading connection…'));
		this.connectionResult = E('p', { 'role': 'status', 'aria-live': 'polite' }, '');
		this.connectionWarning = E('p', { 'class': 'cbi-value-description', 'role': 'status', 'aria-live': 'polite' }, '');
		this.connectionInput = E('textarea', {
			'rows': 5, 'wrap': 'soft', 'class': 'cbi-input-text', 'style': 'width:100%;resize:vertical;overflow-wrap:anywhere;box-sizing:border-box',
			'placeholder': 'vless://…', 'autocomplete': 'off', 'spellcheck': 'false',
			'aria-label': _('VLESS link'), 'disabled': !L.hasViewPermission(),
			'input': L.bind(this.handleConnectionInput, this)
		});
		var connectionButtons = [ [ 'save', _('Save and apply') ], [ 'test', _('Check connection') ] ].map(L.bind(function(action) {
			var button = E('button', {
				'class': 'btn cbi-button-action', 'style': 'margin:.5em .5em .5em 0',
				'click': ui.createHandlerFn(this, 'handleConnection', action[0])
			}, action[1]);
			this.buttons.push(button);
			return button;
		}, this));
		var rows = [
			[ 'status', _('Xray-core status') ],
			[ 'core_version', _('Xray-core version') ],
			[ 'enabled', _('Start on boot') ],
			[ 'pid', _('Process ID') ],
			[ 'uptime', _('Process uptime') ],
			[ 'memory', _('Resident memory') ],
			[ 'updated', _('Last update') ]
		].map(L.bind(function(row) {
			this.fields[row[0]] = E('span', {}, '—');
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, row[1]),
				E('div', { 'class': 'cbi-value-field' }, this.fields[row[0]])
			]);
		}, this));

		var actions = [
			[ 'start', _('Start') ],
			[ 'stop', _('Stop') ],
			[ 'restart', _('Restart') ],
			[ 'enable', _('Enable autostart') ],
			[ 'disable', _('Disable autostart') ]
		].map(L.bind(function(action) {
			var button = E('button', {
				'class': 'btn cbi-button-action',
				'style': 'margin:0 .5em .5em 0',
				'click': ui.createHandlerFn(this, 'handleAction', action[0])
			}, action[1]);
			this.buttons.push(button);
			return button;
		}, this));

		var page = E('div', {}, [
			E('h2', {}, _('Krotex')),
			E('p', {}, _('Service status refreshes every 5 seconds.')),
			E('div', { 'class': 'cbi-section' }, rows),
			E('div', { 'class': 'cbi-section' }, actions),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('VLESS connection')),
				this.connectionSummary,
				E('p', {}, _('Paste a VLESS TCP link with TLS or REALITY. Saving applies the connection and restarts Xray.')),
				this.connectionInput,
				this.connectionWarning,
				E('div', {}, connectionButtons),
				this.connectionResult,
				E('p', {}, _('The connection check sends an HTTPS request to api.ipify.org through this proxy.'))
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Device routing')),
				this.routingSummary,
				E('p', {}, _('Select a device to add it, or enter its MAC address and click Add device. Added devices use the proxy for public IPv4 TCP and UDP traffic. Local IPv4 networks and router access remain direct.')),
				E('div', {}, [ this.deviceSelect, refreshDevices ]),
				E('div', {}, this.routingMac),
				E('div', {}, routingButtons),
				this.routingList,
				this.routingResult,
				E('p', {}, _('DNS is sent through the proxy to 1.1.1.1; local DHCP hostnames may not resolve. Public IPv6 and IPv6 DNS are blocked for added devices to prevent bypass.')),
				E('p', {}, _('Reconnect devices after adding them. Removing a device or stopping Krotex restores direct access.'))
			])
		]);
		this.updateStatus(data);
		this.refreshConnection();
		this.refreshRouting();
		this.refreshDevices();
		poll.add(L.bind(this.refresh, this), 5);
		return page;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});

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
			this.savedRoutingMac = data.mac || '';
			this.routingSummary.textContent = !data.enabled ? _('Device routing is disabled')
				: data.active ? _('Active for %s').format(data.mac)
				: _('Configured for %s; rules are inactive').format(data.mac);
			if (data.active && !this.lastStatus.running)
				this.routingSummary.textContent += ' · ' + _('Xray is stopped');
			if (!this.routingEdited && data.mac)
				this.routingMac.value = data.mac;
		}, this)).catch(L.bind(function() {
			this.routingSummary.textContent = _('Device routing status unavailable');
		}, this));
	},

	refreshDevices: function() {
		return callDevices().then(L.bind(function(data) {
			var options = [ E('option', { 'value': '' }, _('Select a DHCP device')) ];
			(data.devices || []).forEach(function(device) {
				options.push(E('option', { 'value': device.mac }, '%s · %s · %s'.format(
					device.name === '*' ? _('Unnamed device') : device.name, device.address, device.mac)));
			});
			this.deviceSelect.replaceChildren.apply(this.deviceSelect, options);
		}, this)).catch(function(error) {
			ui.addNotification(null, E('p', {}, _('Unable to load DHCP devices. Enter the MAC address manually.')));
		});
	},

	handleRouting: function(enabled) {
		if (this.busy)
			return Promise.resolve();
		var mac = enabled ? this.routingMac.value.trim().toLowerCase() : (this.savedRoutingMac || '');
		if ((enabled || mac) && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
			ui.addNotification(null, E('p', {}, _('Enter a valid device MAC address.')));
			return Promise.resolve();
		}
		this.busy = true;
		this.updateStatus(this.lastStatus);
		this.routingResult.textContent = _('Applying device routing…');
		return callSetRouting(mac, enabled).then(L.bind(function(result) {
			if (result.code !== 0)
				throw new Error(result.message || _('Unable to apply device routing.'));
			this.routingResult.textContent = enabled ? _('Device routing enabled.') : _('Device routing disabled.');
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
		}, this)).catch(L.bind(function() {
			this.connectionSummary.textContent = _('Connection settings unavailable');
		}, this));
	},

	readConnection: function() {
		try {
			var result = vless.inspect(this.connectionInput.value);
			this.connectionWarning.textContent = result.ignored.length
				? _('Ignored parameters (not applied): %s').format(result.ignored.join(', ')) : '';
			return result.profile;
		}
		catch (error) {
			this.connectionWarning.textContent = error.message;
			throw error;
		}
	},

	handleConnectionInput: function() {
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

		this.buttons.forEach(L.bind(function(button) {
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
		this.routingEdited = false;
		this.routingSummary = E('p', {}, _('Loading device routing…'));
		this.routingResult = E('p', { 'role': 'status', 'aria-live': 'polite' }, '');
		this.routingMac = E('input', {
			'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'aa:bb:cc:dd:ee:ff',
			'aria-label': _('Device MAC address'), 'autocomplete': 'off', 'spellcheck': 'false',
			'input': L.bind(function() { this.routingEdited = true; }, this)
		});
		this.deviceSelect = E('select', {
			'class': 'cbi-input-select', 'aria-label': _('Device'),
			'change': L.bind(function() {
				if (this.deviceSelect.value) {
					this.routingMac.value = this.deviceSelect.value;
					this.routingEdited = true;
				}
			}, this)
		}, []);
		var routingButtons = [ [ true, _('Route this device') ], [ false, _('Disable device routing') ] ].map(L.bind(function(action) {
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
			'rows': 5, 'class': 'cbi-input-text', 'style': 'width:100%;resize:vertical;overflow-wrap:anywhere',
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
				E('p', {}, _('Select one device or enter its MAC address. Its public IPv4 TCP and UDP traffic will use the proxy. Local IPv4 networks and router access remain direct.')),
				E('div', {}, [ this.deviceSelect, refreshDevices ]),
				E('div', {}, this.routingMac),
				E('div', {}, routingButtons),
				this.routingResult,
				E('p', {}, _('DNS is sent through the proxy to 1.1.1.1; local DHCP hostnames may not resolve. Public IPv6 and IPv6 DNS are blocked for this device to prevent bypass.')),
				E('p', {}, _('Reconnect the device after applying the rule. Disabling routing or stopping Krotex restores direct access.'))
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

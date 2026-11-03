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

return view.extend({
	load: function() {
		return callStatus().catch(function() {
			return { available: false };
		});
	},

	refresh: function() {
		return callStatus().then(L.bind(function(data) {
			this.updateStatus(data);
		}, this)).catch(L.bind(function() {
			this.updateStatus({ available: false });
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
		this.fields.uptime.textContent = running ? duration : '—';
		this.fields.memory.textContent = running ? '%.1f MiB'.format((Number(data.memory_kib) || 0) / 1024) : '—';
		this.fields.updated.textContent = available ? new Date().toLocaleTimeString() : '—';

		this.buttons.forEach(L.bind(function(button) {
			button.disabled = !!this.busy || !available || !L.hasViewPermission();
		}, this));
		this.connectionInput.disabled = !!this.busy || !available || !L.hasViewPermission();
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
			E('p', { 'class': 'cbi-section-descr' }, _('The local SOCKS listener is 127.0.0.1:10808. Device traffic is not redirected automatically.'))
		]);
		this.updateStatus(data);
		this.refreshConnection();
		poll.add(L.bind(this.refresh, this), 5);
		return page;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});

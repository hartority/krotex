'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

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
			E('p', { 'class': 'cbi-section-descr' },
				_('The initial configuration provides a local SOCKS listener at 127.0.0.1:10808 with direct outbound access. Traffic routing rules are not configured yet.'))
		]);
		this.updateStatus(data);
		poll.add(L.bind(this.refresh, this), 5);
		return page;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});

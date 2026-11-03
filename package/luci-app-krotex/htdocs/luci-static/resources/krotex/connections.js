'use strict';
'require baseclass';
'require rpc';

var readConnections = rpc.declare({ object: 'krotex', method: 'connections', expect: { '': {} } });
var testProfile = rpc.declare({ object: 'krotex', method: 'test_profile', params: [ 'id' ], expect: { '': {} } });

return baseclass.extend({
	create: function(options) {
		var checker = Object.create(this);
		checker.options = options || {};
		checker.entries = [];
		checker.outputs = Object.create(null);
		return checker;
	},

	setState: function(busy, available) {
		this.externalBusy = !!busy;
		this.available = available;
		this.button.disabled = !available || !L.hasViewPermission() || !this.loaded || !this.entries.length || (busy && !this.testing) || (this.testing && this.cancelled);
		this.button.textContent = this.testing ? _('Stop checking') : _('Check all');
		this.maybeCheck();
	},

	setVisible: function(visible) {
		this.visible = visible;
		this.maybeCheck();
	},

	maybeCheck: function() {
		if (this.visible && this.loaded && !this.autoChecked && !this.testing && !this.externalBusy && this.available && this.entries.length && L.hasViewPermission()) this.checkAll();
	},

	load: function() {
		this.loaded = false;
		this.summary.textContent = _('Loading connections...');
		this.setState(this.externalBusy, this.available);
		return readConnections().then(L.bind(function(data) {
			if (data.code) throw new Error(data.message);
			this.entries = data.connections || [];
			this.loaded = true;
			this.autoChecked = false;
			this.outputs = Object.create(null);
			var rows = this.entries.map(L.bind(function(entry) {
				var output = E('span', { 'role': 'status', 'aria-live': 'polite', 'style': 'flex:1;min-width:12em;overflow-wrap:anywhere' }, _('Not checked'));
				this.outputs[entry.id] = output;
				return E('li', { 'style': 'display:flex;align-items:center;flex-wrap:wrap;gap:.5em 1.5em;padding:.75em 0;border-bottom:1px solid #8883' }, [
					E('div', { 'style': 'flex:1;min-width:12em;overflow-wrap:anywhere' }, [
						E('strong', { 'style': 'display:block' }, entry.endpoint),
						E('span', { 'style': 'font-size:.9em;opacity:.8' }, entry.sections.join(', ')) ]), output ]);
			}, this));
			this.list.replaceChildren.apply(this.list, rows.length ? rows : [ E('li', {}, _('No saved Xray connections.')) ]);
			this.summary.textContent = '';
			this.setState(this.externalBusy, this.available);
		}, this)).catch(L.bind(function(error) { this.summary.textContent = error.message || _('Unable to load connections.'); }, this));
	},

	setResult: function(id, text, color) {
		var output = this.outputs[id];
		if (output) { output.textContent = text; output.style.color = color || ''; }
	},

	checkAll: function() {
		if (this.testing) { this.cancelled = true; this.button.disabled = true; this.summary.textContent = _('Stopping after the current check...'); return Promise.resolve(); }
		if (!this.loaded || !this.available || this.externalBusy || !L.hasViewPermission() || !this.entries.length) return Promise.resolve();
		this.testing = true; this.cancelled = false; this.autoChecked = true;
		this.entries.forEach(L.bind(function(entry) { this.setResult(entry.id, _('Not checked')); }, this));
		if (this.options.onBusy) this.options.onBusy(true);
		this.setState(this.externalBusy, this.available);
		var queue = Promise.resolve();
		this.entries.forEach(L.bind(function(entry, index) {
			queue = queue.then(L.bind(function() {
				if (this.cancelled) return;
				this.summary.textContent = _('Checking %s of %s').format(index + 1, this.entries.length);
				this.setResult(entry.id, _('Checking...'));
				return testProfile(entry.id).then(L.bind(function(result) {
					if (result.code !== 0) throw new Error(result.message || _('Connection failed.'));
					var text = _('Working. Exit IP: %s').format(result.ip);
					if (Number.isFinite(result.latency_ms) && result.latency_ms >= 0) text += ' \u00b7 ' + _('Latency: %s ms').format(Math.round(result.latency_ms));
					this.setResult(entry.id, text, '#22863a');
				}, this)).catch(L.bind(function(error) { this.setResult(entry.id, error.message || _('Connection failed.'), '#d93025'); }, this));
			}, this));
		}, this));
		var finish = L.bind(function(error) {
			this.testing = false;
			this.summary.textContent = error ? (error.message || _('Unable to complete checks.')) : this.cancelled ? _('Check stopped.') : _('Checks complete.');
			if (this.options.onBusy) this.options.onBusy(false);
			this.setState(this.externalBusy, this.available);
		}, this);
		return queue.then(function() { finish(); }, finish);
	},

	render: function() {
		this.list = E('ul', { 'style': 'list-style:none;padding:0;margin:.5em 0' }, []);
		this.summary = E('span', { 'role': 'status', 'style': 'overflow-wrap:anywhere' }, _('Loading connections...'));
		this.button = E('button', { 'type': 'button', 'class': 'btn cbi-button-action', 'click': L.bind(this.checkAll, this) }, _('Check all'));
		this.button.disabled = true;
		return E('div', { 'class': 'cbi-section', 'aria-label': _('Xray connections'), 'style': 'padding:1em;margin:.5em 0 1em;border:1px solid #8884;border-radius:6px' }, [
			E('h3', { 'style': 'margin:0 0 .5em' }, _('Xray connections')),
			E('p', {}, _('Unique saved connections from all routing sections, including disabled ones. Each is checked once when Overview opens. Latency is HTTPS response time, including connection setup.')),
			this.list,
			E('div', { 'style': 'display:flex;align-items:center;flex-wrap:wrap;gap:.5em 1em;margin-top:.75em' }, [ this.button, this.summary ]) ]);
	}
});

'use strict';
'require baseclass';
'require rpc';
'require ui';
'require krotex.vless as vless';

var readSections = rpc.declare({ object: 'krotex', method: 'sections', expect: { '': {} } });
var saveSections = rpc.declare({ object: 'krotex', method: 'save_sections', params: [ 'sections' ], expect: { '': {} } });
var testSection = rpc.declare({ object: 'krotex', method: 'test_section', params: [ 'id' ], expect: { '': {} } });

return baseclass.extend({
	create: function(options) {
		var editor = Object.create(this);
		editor.options = options || {};
		editor.sections = [];
		editor.controls = [];
		editor.checkResults = Object.create(null);
		editor.available = false;
		return editor;
	},

	setState: function(busy, available) {
		this.externalBusy = busy;
		this.available = available;
		var disabled = !!busy || !!this.saving || !!this.testing || !!this.resetting || !available || !this.loaded || !L.hasViewPermission();
		(this.controls || []).forEach(function(control) { control.disabled = disabled || !!control.krotexBoundary; });
		if (this.saveButton) this.saveButton.disabled = disabled || !this.dirty;
		if (this.resetButton) this.resetButton.disabled = disabled || !this.dirty;
	},

	changed: function() {
		this.dirty = true;
		this.checkResults = Object.create(null);
		Object.keys(this.checkOutputs || {}).forEach(L.bind(function(id) { this.setCheckResult(id, '', false); }, this));
		this.setState(this.externalBusy, this.available);
	},

	load: function() {
		return readSections().then(L.bind(function(data) {
			if (data.code) throw new Error(data.message);
			this.sections = (data.sections || []).map(function(section) {
				return { id: section.id, name: section.name, mode: section.mode,
					enabled: section.enabled, fallback: section.fallback,
					domains: (section.domains || []).join('\n'),
					url: section.profile ? (section.profile.url || vless.format(section.profile)) : '' };
			});
			this.loaded = true;
			this.dirty = !!data.legacy;
			this.checkResults = Object.create(null);
			this.renderCards();
		}, this)).catch(L.bind(function(error) {
			this.result.textContent = error.message || _('Unable to load sections.');
			throw error;
		}, this));
	},

	add: function() {
		if (this.externalBusy || this.saving || !this.loaded || !L.hasViewPermission()) return;
		if (this.sections.length >= 32) {
			this.result.textContent = _('A maximum of 32 sections is supported.');
			return;
		}
		this.sections.push({ id: 'section-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
			name: _('New section'), mode: 'unconfigured', enabled: false, fallback: false, domains: '', url: '' });
		this.changed();
		this.renderCards();
	},

	move: function(index, offset) {
		var target = index + offset;
		if (target < 0 || target >= this.sections.length || this.externalBusy || this.saving) return;
		var item = this.sections.splice(index, 1)[0];
		this.sections.splice(target, 0, item);
		this.changed();
		this.renderCards();
	},

	remove: function(index) {
		if (this.externalBusy || this.saving || !L.hasViewPermission()) return;
		this.sections.splice(index, 1);
		this.changed();
		this.renderCards();
	},

	fitLink: function(input) {
		setTimeout(function() {
			input.style.height = 'auto';
			input.style.height = Math.max(100, input.scrollHeight + (input.offsetHeight || 0) - (input.clientHeight || 0)) + 'px';
		}, 0);
	},

	linkWarning: function(input, output) {
		output.textContent = '';
		if (input.value.trim()) {
			try {
				var result = vless.inspect(input.value);
				if (result.ignored.length) output.textContent = _('Ignored parameters (not applied): %s').format(result.ignored.join(', '));
			}
			catch (error) { output.textContent = error.message; }
		}
		this.fitLink(input);
	},

	renderCards: function() {
		this.controls = this.topControls.slice();
		this.checkOutputs = Object.create(null);
		var cards = this.sections.map(L.bind(function(section, index) {
			var name = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': section.name,
				'maxlength': 128, 'aria-label': _('Section name'), 'style': 'flex:1;min-width:0;width:auto',
				'input': L.bind(function(event) { section.name = event.target.value; this.changed(); }, this) });
			var mode = E('select', { 'class': 'cbi-input-select', 'aria-label': _('Section route'),
				'change': L.bind(function(event) {
					var wasUnconfigured = section.mode === 'unconfigured';
					section.mode = event.target.value;
					if (section.mode === 'unconfigured') { section.enabled = false; section.fallback = false; }
					else if (wasUnconfigured) section.enabled = true;
					this.changed(); this.renderCards();
				}, this)
			}, [ E('option', { 'value': 'unconfigured' }, _('Not configured')),
				E('option', { 'value': 'direct' }, _('Direct')), E('option', { 'value': 'proxy' }, _('Xray')) ]);
			// LuCI sets attributes verbatim: selected="false" is still selected.
			mode.value = section.mode;
			var enabled = E('input', { 'type': 'checkbox', 'aria-label': _('Enable section'),
				'change': L.bind(function(event) { section.enabled = event.target.checked; if (!section.enabled) section.fallback = false; this.changed(); this.renderCards(); }, this) });
			enabled.checked = !!section.enabled;
			enabled.krotexBoundary = section.mode === 'unconfigured';
			var fallback = E('input', { 'type': 'checkbox', 'aria-label': _('Use for unmatched traffic'),
				'change': L.bind(function(event) {
					var checked = event.target.checked;
					this.sections.forEach(function(item) { item.fallback = false; });
					section.fallback = checked;
					if (checked) section.enabled = true;
					this.changed(); this.renderCards();
				}, this) });
			fallback.checked = !!section.fallback;
			fallback.style.margin = '0';
			fallback.style.flex = '0 0 auto';
			fallback.krotexBoundary = section.mode === 'unconfigured';
			var domains = E('textarea', { 'rows': 4, 'class': 'cbi-input-text', 'style': 'width:100%;box-sizing:border-box;resize:vertical',
				'placeholder': 'youtube.com\ngooglevideo.com\nytimg.com', 'aria-label': _('Domains'), 'spellcheck': 'false',
				'input': L.bind(function(event) { section.domains = event.target.value; this.changed(); }, this) });
			domains.value = section.domains;
			var buttons = [ [ '↑', -1 ], [ '↓', 1 ] ].map(L.bind(function(item) {
				var button = E('button', { 'type': 'button', 'class': 'btn', 'style': 'flex:0 0 auto', 'aria-label': item[1] < 0 ? _('Move section up') : _('Move section down'),
					'click': L.bind(function() { this.move(index, item[1]); }, this) }, item[0]);
				button.krotexBoundary = index + item[1] < 0 || index + item[1] >= this.sections.length;
				this.controls.push(button);
				return button;
			}, this));
			var remove = E('button', { 'type': 'button', 'class': 'btn cbi-button-negative', 'style': 'flex:0 0 auto', 'aria-label': _('Remove section'),
				'click': L.bind(function() { this.remove(index); }, this) }, '×');
			this.controls.push(name, mode, enabled, fallback, domains, remove);
			var fields = [ E('div', { 'style': 'display:flex;align-items:center;gap:.5em;margin-bottom:.7em' }, [ name ].concat(buttons, [remove])),
				E('p', {}, [ mode, ' ', E('label', {}, [ enabled, ' ', _('Enabled') ]) ]) ];
			if (section.mode === 'proxy') {
				var warning = E('p', { 'role': 'status', 'class': 'cbi-value-description' }, '');
				var link = E('textarea', { 'rows': 4, 'wrap': 'soft', 'class': 'cbi-input-text',
					'style': 'width:100%;box-sizing:border-box;resize:vertical;overflow-wrap:anywhere',
					'aria-label': _('VLESS link'), 'placeholder': 'vless://…', 'spellcheck': 'false', 'autocomplete': 'off',
					'input': L.bind(function(event) { section.url = event.target.value; this.changed(); this.linkWarning(link, warning); }, this) });
				link.value = section.url;
				this.controls.push(link);
				var test = E('button', { 'type': 'button', 'class': 'btn cbi-button-action', 'click': L.bind(function() { return this.test(section); }, this) }, _('Check connection'));
				var result = E('span', { 'role': 'status', 'aria-live': 'polite', 'aria-label': _('Connection check result'),
					'style': 'flex:1;min-width:10em;overflow-wrap:anywhere' }, '');
				this.checkOutputs[section.id] = result;
				var previous = this.checkResults[section.id];
				if (previous) this.setCheckResult(section.id, previous.text, previous.error);
				this.controls.push(test);
				fields.push(E('label', { 'style': 'display:block;margin:.5em 0 .25em' }, _('VLESS connection')), link, warning,
					E('div', { 'style': 'display:flex;align-items:center;flex-wrap:wrap;gap:.5em 1em;margin:.5em 0 1em' }, [ test, result ]));
				this.linkWarning(link, warning);
			}
			if (section.mode !== 'unconfigured')
				fields.push(E('label', { 'style': 'display:block;margin:.5em 0 .25em' }, _('Domains (one per line, including subdomains)')), domains,
					E('div', { 'style': 'margin-top:.85em;padding:.25em 0' }, [
						E('label', { 'style': 'display:inline-flex;align-items:center;gap:.45em;line-height:1.5' }, [ fallback, _('Use this section for all unmatched traffic') ])
					]));
			else
				fields.push(E('p', { 'class': 'cbi-value-description' }, _('Choose a section type to configure routing.')));
			return E('div', { 'class': 'cbi-section', 'style': 'border:1px solid #8886;border-radius:6px;padding:1em;margin:1em 0' }, fields);
		}, this));
		this.cards.replaceChildren.apply(this.cards, cards.length ? cards : [ E('p', {}, _('No sections. Unmatched traffic goes directly.')) ]);
		this.setState(this.externalBusy, this.available);
	},

	setCheckResult: function(id, text, error) {
		this.checkResults[id] = { text: text, error: !!error };
		var output = (this.checkOutputs || {})[id];
		if (output) {
			output.textContent = text;
			output.style.color = error ? '#d93025' : text ? '#22863a' : '';
		}
	},

	reset: function() {
		if (this.externalBusy || this.saving || this.testing || this.resetting || !this.loaded || !L.hasViewPermission()) return Promise.resolve();
		this.resetting = true;
		if (this.options.onBusy) this.options.onBusy(true);
		this.setState(this.externalBusy, this.available);
		return this.load().then(L.bind(function() { this.result.textContent = ''; }, this))
			.catch(function() { /* load() displays the read error and retains the edits. */ })
			.then(L.bind(function() {
				this.resetting = false;
				if (this.options.onBusy) this.options.onBusy(false);
				this.setState(this.externalBusy, this.available);
			}, this));
	},

	test: function(section) {
		if (this.externalBusy || this.saving || this.testing || !L.hasViewPermission()) return Promise.resolve();
		if (this.dirty) { this.setCheckResult(section.id, _('Save sections before checking this connection.'), true); return Promise.resolve(); }
		this.testing = true;
		if (this.options.onBusy) this.options.onBusy(true);
		this.setState(this.externalBusy, this.available);
		this.setCheckResult(section.id, _('Checking connection…'), false);
		return testSection(section.id).then(L.bind(function(result) {
			if (result.code !== 0) throw new Error(result.message || _('Connection check failed.'));
			this.setCheckResult(section.id, _('Connection successful. Exit IP: %s').format(result.ip), false);
		}, this)).catch(L.bind(function(error) { this.setCheckResult(section.id, error.message, true); }, this)).then(L.bind(function() {
			this.testing = false;
			if (this.options.onBusy) this.options.onBusy(false);
			this.setState(this.externalBusy, this.available);
		}, this));
	},

	serialize: function() {
		return this.sections.map(function(section) {
			var data = { id: section.id, name: section.name, mode: section.mode, enabled: section.enabled, fallback: section.fallback,
				domains: section.domains.split(/\r?\n/).map(function(line) { return line.trim(); }).filter(function(line) { return line && line.charAt(0) !== '#'; }) };
			if (section.mode === 'proxy' && (section.enabled || section.url.trim())) {
				try { data.profile = vless.inspect(section.url).profile; data.profile.url = section.url.trim(); }
				catch (error) { throw new Error('%s: %s'.format(section.name, error.message)); }
			}
			return data;
		});
	},

	save: function() {
		if (this.externalBusy || this.saving || !this.loaded || !L.hasViewPermission()) return Promise.resolve();
		var sections;
		try { sections = this.serialize(); }
		catch (error) { this.result.textContent = error.message; return Promise.resolve(); }
		this.saving = true;
		if (this.options.onBusy) this.options.onBusy(true);
		this.setState(this.externalBusy, this.available);
		this.result.textContent = _('Applying sections…');
		return saveSections(JSON.stringify(sections)).then(L.bind(function(result) {
			if (result.code !== 0) throw new Error(result.message || _('Unable to apply sections.'));
			return this.load().then(L.bind(function() { this.result.textContent = _('Sections saved and applied.'); }, this));
		}, this)).catch(L.bind(function(error) {
			this.result.textContent = error.message;
			ui.addNotification(null, E('p', {}, error.message));
		}, this)).then(L.bind(function() {
			this.saving = false;
			if (this.options.onBusy) this.options.onBusy(false);
			this.setState(this.externalBusy, this.available);
			return this.options.onApplied ? this.options.onApplied() : null;
		}, this));
	},

	render: function() {
		this.cards = E('div', {}, []);
		this.result = E('p', { 'role': 'status', 'aria-live': 'polite' }, _('Loading sections…'));
		var addSection = E('button', { 'type': 'button', 'class': 'btn cbi-button-action', 'click': L.bind(this.add, this) }, _('Add section'));
		this.saveButton = E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-apply cbi-button-positive',
			'style': 'background:#218739;border-color:#1c7532;color:#fff', 'click': L.bind(this.save, this) }, _('Save sections and apply'));
		this.resetButton = E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-reset', 'click': L.bind(this.reset, this) }, _('Reset'));
		this.topControls = [ addSection, this.saveButton, this.resetButton ];
		this.controls = this.topControls.slice();
		this.setState(false, this.available);
		this.load().then(L.bind(function() { if (this.loaded) this.result.textContent = ''; }, this)).catch(function() {});
		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Routing sections')),
			E('p', {}, _('Sections match domains from top to bottom. The first match wins. One section can handle all unmatched traffic; otherwise it goes directly.')),
			E('p', {}, _('Rules apply according to the device routing mode below. Domains are detected from HTTP, TLS and QUIC; connections without a visible hostname use the default route.')),
			E('div', {}, [ addSection ]), this.cards,
			E('div', { 'style': 'display:flex;align-items:center;flex-wrap:wrap;gap:.5em;margin-top:1em' }, [ this.saveButton, this.resetButton ]), this.result
		]);
	}
});

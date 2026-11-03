'use strict';
'require baseclass';

return baseclass.extend({
	create: function(options) {
		var mac = options.mac, device = options.device;
		var name = device && device.name && device.name !== '*' ? device.name : _('Unnamed device');
		var remove = E('button', {
			'class': 'btn cbi-button-negative', 'type': 'button', 'title': _('Remove device'),
			'aria-label': options.removeLabel || _('Remove device %s').format(mac),
			'click': options.onRemove
		}, '\u00d7');
		var details = [ E('code', { 'style': 'color:inherit;background:none;padding:0;font-size:.9em;white-space:normal;overflow-wrap:anywhere' }, mac) ];
		if (device && device.address) details.unshift(E('span', { 'style': 'font-size:.9em' }, device.address));
		var element = E('li', { 'style': 'display:flex;align-items:center;justify-content:space-between;gap:1em;padding:.8em 1em;margin:.6em 0;border:1px solid #409eff66;border-radius:8px;background:rgba(64,158,255,.08);color:inherit' }, [
			E('div', { 'style': 'min-width:0;flex:1;color:inherit' }, [
				E('strong', { 'style': 'display:block;color:inherit;font-size:1em;margin-bottom:.3em;overflow-wrap:anywhere' }, name),
				E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:.2em 1em;color:inherit' }, details)
			]), remove
		]);
		return { element: element, removeButton: remove };
	}
});

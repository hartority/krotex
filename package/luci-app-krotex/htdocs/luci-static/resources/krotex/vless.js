'use strict';
'require baseclass';

return baseclass.extend({
	parse: function(value) {
		return this.inspect(value).profile;
	},

	inspect: function(value) {
		var url;
		try {
			url = new URL(value.trim());
		}
		catch (error) {
			throw new Error(_('Enter a valid VLESS link.'));
		}
		if (url.protocol !== 'vless:' || url.password || (url.pathname && url.pathname !== '/'))
			throw new Error(_('Enter a valid VLESS link.'));

		var params = url.searchParams;
		var allowed = [ 'encryption', 'security', 'type', 'flow', 'sni', 'fp', 'pbk', 'sid', 'spx', 'alpn', 'headerType' ];
		var ignored = [];
		params.forEach(function(value, key) {
			if (params.getAll(key).length !== 1)
				throw new Error(_('Repeated VLESS parameter: %s').format(key));
			if (allowed.indexOf(key) === -1)
				ignored.push(key);
		});
		if ([ 'tcp', 'raw' ].indexOf(params.get('type') || 'tcp') === -1 ||
			(params.get('headerType') && params.get('headerType') !== 'none'))
			throw new Error(_('This connection requires VLESS over TCP (TLS or REALITY).'));
		if (params.get('encryption') && params.get('encryption') !== 'none')
			throw new Error(_('Only VLESS encryption=none is supported.'));

		var profile = {
			id: decodeURIComponent(url.username),
			address: url.hostname.replace(/^\[|\]$/g, ''),
			port: Number(url.port),
			security: params.get('security') || '',
			server_name: params.get('sni') || '',
			fingerprint: params.get('fp') || 'chrome',
			public_key: params.get('pbk') || '',
			short_id: params.get('sid') || '',
			spider_x: params.get('spx') || '/',
			flow: params.get('flow') || '',
			alpn: params.get('alpn') || ''
		};
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile.id))
			throw new Error(_('The VLESS link must contain a valid UUID.'));
		if (!profile.address || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535)
			throw new Error(_('The VLESS link must contain a server address and port.'));
		if ([ 'tls', 'reality' ].indexOf(profile.security) === -1)
			throw new Error(_('Choose a VLESS link with TLS or REALITY security.'));
		if (profile.flow && profile.flow !== 'xtls-rprx-vision')
			throw new Error(_('Unsupported VLESS flow.'));
		if (profile.security === 'reality' && (!profile.server_name || !/^[A-Za-z0-9_-]{43}$/.test(profile.public_key)))
			throw new Error(_('The REALITY link must contain SNI and a valid public key.'));
		if (!/^(?:[0-9a-f]{2}){0,8}$/i.test(profile.short_id))
			throw new Error(_('Invalid REALITY short ID.'));
		if (profile.security === 'reality' && profile.alpn)
			throw new Error(_('Custom ALPN is supported only for TLS connections.'));
		return { profile: profile, ignored: ignored };
	}
});

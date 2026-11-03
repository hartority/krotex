// Compile the section model into Xray configuration. No raw Xray objects are
// accepted from RPC; every outbound and rule is rebuilt from validated fields.
import { readfile } from 'fs';

function check(ok, message) {
	if (!ok) die(message);
}

function text(value, limit, field) {
	check(type(value) == 'string' && length(value) <= limit, 'Invalid ' + field + '.');
	return value;
}

function profile_from_outbound(outbound, url) {
	let stream = outbound.streamSettings || {};
	let settings = stream.realitySettings || stream.tlsSettings || {};
	let server = outbound.settings?.vnext?.[0] || {};
	let user = server.users?.[0] || {};
	return {
		id: user.id, address: server.address, port: server.port,
		security: stream.security, server_name: settings.serverName || '',
		fingerprint: settings.fingerprint || 'chrome', public_key: settings.publicKey || settings.password || '',
		short_id: settings.shortId || '', spider_x: settings.spiderX || '/',
		flow: user.flow || '', alpn: join(',', settings.alpn || []), url: url || ''
	};
}

function current_sections(config) {
	if (type(config.krotex_sections) == 'array') return config.krotex_sections;
	for (let outbound in config.outbounds || []) {
		if (outbound.tag == 'proxy' && outbound.protocol == 'vless')
			return [{ id: 'vpn-1', name: 'VPN 1', mode: 'proxy', enabled: true, fallback: true,
				domains: [], profile: profile_from_outbound(outbound, config.krotex_link) }];
	}
	return [];
}

function proxy_profile(input) {
	check(type(input) == 'object', 'Enter a VLESS connection for each Xray section.');
	let p = {};
	for (let key in ['id', 'address', 'security', 'server_name', 'fingerprint', 'public_key', 'short_id', 'spider_x', 'flow', 'alpn'])
		p[key] = text(input[key], 2048, 'VLESS ' + key);
	check(match(p.id, /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/), 'Invalid VLESS UUID.');
	check(length(p.address) && !match(p.address, /[^a-zA-Z0-9:._-]/), 'Invalid VLESS server address.');
	check(type(input.port) == 'int' && input.port >= 1 && input.port <= 65535, 'Invalid VLESS server port.');
	p.port = input.port;
	check(p.security == 'tls' || p.security == 'reality', 'TLS or REALITY is required.');
	check(!match(p.server_name, /[^a-zA-Z0-9._-]/), 'Invalid server name.');
	check(index(['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized'], p.fingerprint) >= 0, 'Unsupported TLS fingerprint.');
	check(p.flow == '' || p.flow == 'xtls-rprx-vision', 'Unsupported VLESS flow.');
	check(!match(p.alpn, /[^a-zA-Z0-9\/.,_-]/) && !match(p.alpn, /(^,|,$|,,)/), 'Invalid ALPN.');
	if (p.security == 'reality') {
		check(length(p.server_name) && match(p.public_key, /^[A-Za-z0-9_-]{43}$/), 'REALITY requires SNI and a valid public key.');
		check(match(p.short_id, /^([0-9a-fA-F]{2}){0,8}$/), 'Invalid REALITY short ID.');
		check(!length(p.alpn), 'Custom ALPN is supported only for TLS.');
	}
	p.url = text(input.url || '', 16384, 'VLESS link');
	check(!length(p.url) || index(p.url, 'vless://') == 0, 'Invalid VLESS link.');
	return p;
}

function outbound(profile, tag) {
	let user = { id: profile.id, encryption: 'none' };
	if (profile.flow) user.flow = profile.flow;
	let settings = { fingerprint: profile.fingerprint };
	if (profile.server_name) settings.serverName = profile.server_name;
	let stream = { network: 'tcp', security: profile.security };
	if (profile.security == 'reality') {
		settings.publicKey = profile.public_key;
		settings.shortId = profile.short_id;
		settings.spiderX = profile.spider_x;
		stream.realitySettings = settings;
	}
	else {
		if (profile.alpn) settings.alpn = split(profile.alpn, ',');
		stream.tlsSettings = settings;
	}
	return { tag, protocol: 'vless', settings: { vnext: [{ address: profile.address, port: profile.port, users: [user] }] }, streamSettings: stream };
}

function normalize(input) {
	check(type(input) == 'array' && length(input) <= 32, 'A maximum of 32 sections is supported.');
	let sections = [], ids = {}, defaults = 0, domain_count = 0;
	for (let item in input) {
		check(type(item) == 'object', 'Invalid section.');
		let id = text(item.id, 64, 'section ID');
		check(match(id, /^[a-z][a-z0-9_-]*$/) && !ids[id], 'Section IDs must be unique.');
		ids[id] = true;
		let name = trim(text(item.name, 128, 'section name'));
		check(length(name), 'Enter a section name.');
		check(item.mode == 'direct' || item.mode == 'proxy', 'Invalid section mode.');
		check(type(item.enabled) == 'bool' && type(item.fallback) == 'bool', 'Invalid section state.');
		if (item.fallback) {
			check(item.enabled, 'The default section must be enabled.');
			check(++defaults == 1, 'Only one section can handle unmatched traffic.');
		}
		check(type(item.domains) == 'array', 'Enter a list of domains.');
		let domains = [], seen = {};
		for (let value in item.domains) {
			let domain = lc(trim(text(value, 253, 'domain')));
			domain = replace(domain, /^\*\./, '');
			domain = replace(domain, /\.$/, '');
			check(length(domain) && !match(domain, /[^a-z0-9.-]/) && !match(domain, /^[0-9.]+$/), 'Enter domain names, without URLs, paths or IP addresses.');
			for (let label in split(domain, '.'))
				check(length(label) <= 63 && match(label, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/), 'Invalid domain: ' + domain);
			if (seen[domain]) continue;
			seen[domain] = true;
			check(++domain_count <= 8192, 'A maximum of 8192 domains is supported.');
			push(domains, domain);
		}
		let section = { id, name, mode: item.mode, enabled: item.enabled, fallback: item.fallback, domains };
		if (item.mode == 'proxy' && (item.enabled || item.profile != null)) section.profile = proxy_profile(item.profile);
		push(sections, section);
	}
	return sections;
}

function compile(sections) {
	let rules = [{ type: 'field', inboundTag: ['device-dns'], outboundTag: 'device-dns-proxy' }];
	let outbounds = [], dns_profile = null, fallback = 'direct';
	let traffic = ['device-tproxy', 'local-socks'];
	let inbounds = [{ tag: 'local-socks', listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { auth: 'noauth', udp: false } }];
	for (let index, section in sections) {
		if (!section.enabled) continue;
		let tag = section.mode == 'proxy' ? 'section-' + section.id : 'direct';
		if (section.mode == 'proxy') {
			push(outbounds, outbound(section.profile, tag));
			let check_tag = 'section-check-' + section.id;
			push(inbounds, { tag: check_tag, listen: '127.0.0.1', port: 11080 + index, protocol: 'socks', settings: { auth: 'noauth', udp: false } });
			push(rules, { type: 'field', inboundTag: [check_tag], outboundTag: tag });
			if (!dns_profile || section.fallback) dns_profile = section.profile;
		}
		if (section.fallback) fallback = tag;
		if (length(section.domains))
			push(rules, { type: 'field', inboundTag: traffic, domain: map(section.domains, d => 'domain:' + d), outboundTag: tag });
	}
	// Explicit catch-all is last regardless of where the default section is
	// displayed. It must not swallow another section's domain rules or DNS.
	push(rules, { type: 'field', inboundTag: traffic, outboundTag: fallback });
	// The existing transparent DNS relay uses this tag. Keep DNS outside domain
	// rules and send it over the default VPN, the first enabled VPN, or direct.
	unshift(outbounds, { tag: 'direct', protocol: 'freedom' });
	unshift(outbounds, dns_profile ? outbound(dns_profile, 'proxy') : { tag: 'proxy', protocol: 'freedom' });
	return {
		krotex_sections: sections,
		log: { loglevel: 'warning' },
		inbounds,
		outbounds,
		routing: { domainStrategy: 'AsIs', rules }
	};
}

try {
	let config = json(readfile(ARGV[1]));
	check(type(config) == 'object', 'Unable to read the Xray configuration.');
	if (ARGV[0] == 'read')
		printf('%J\n', { sections: current_sections(config), legacy: config.krotex_sections == null });
	else if (ARGV[0] == 'check') {
		let request = json(readfile(ARGV[2], 262145));
		let found = false;
		for (let index, section in config.krotex_sections || []) {
			if (section.id != request.id) continue;
			check(section.enabled && section.mode == 'proxy', 'Choose an enabled Xray section.');
			printf('%J\n', { port: 11080 + index });
			found = true;
			break;
		}
		check(found, 'Save this Xray section before checking its connection.');
	}
	else if (ARGV[0] == 'compile') {
		let request = json(readfile(ARGV[2], 262145));
		check(type(request.sections) == 'string', 'Invalid sections request.');
		printf('%J\n', compile(normalize(json(request.sections))));
	}
	else die('Unknown sections operation.');
}
catch (error) {
	warn('Krotex: ', error.message, '\n');
	exit(1);
}

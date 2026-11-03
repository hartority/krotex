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

function device_macs(input) {
	check(type(input) == 'array' && length(input) <= 128, 'Select up to 128 devices.');
	let macs = [], seen = {};
	for (let value in input) {
		let mac = lc(text(value, 17, 'MAC address'));
		check(match(mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/) && mac != '00:00:00:00:00:00' && !match(mac, /^[0-9a-f][13579bdf]:/), 'Enter a valid unicast device MAC address.');
		if (!seen[mac]) { seen[mac] = true; push(macs, mac); }
	}
	return macs;
}

function ipv4_destination(value) {
	let parts = split(value, '/');
	check(length(parts) <= 2, 'Invalid IP address or subnet: ' + value);
	let address = iptoarr(parts[0]);
	check(address && length(address) == 4, 'Enter a valid IPv4 address or subnet: ' + value);
	if (length(parts) == 1) return arrtoip(address);
	check(match(parts[1], /^[0-9]{1,2}$/) && int(parts[1], 10) <= 32, 'IPv4 subnet prefix must be between 0 and 32: ' + value);
	let prefix = int(parts[1], 10), remaining = prefix;
	for (let i = 0; i < 4; i++) {
		if (remaining >= 8) remaining -= 8;
		else if (remaining <= 0) address[i] = 0;
		else { address[i] &= 255 << (8 - remaining); remaining = 0; }
	}
	return arrtoip(address) + '/' + prefix;
}

function normalize(input) {
	check(type(input) == 'array' && length(input) <= 32, 'A maximum of 32 sections is supported.');
	let sections = [], ids = {}, defaults = 0, domain_count = 0, assigned = {}, device_count = 0;
	for (let item in input) {
		check(type(item) == 'object', 'Invalid section.');
		let id = text(item.id, 64, 'section ID');
		check(match(id, /^[a-z][a-z0-9_-]*$/) && !ids[id], 'Section IDs must be unique.');
		ids[id] = true;
		let name = trim(text(item.name, 128, 'section name'));
		check(length(name), 'Enter a section name.');
		check(item.mode == 'direct' || item.mode == 'proxy' || item.mode == 'proxy_devices' || item.mode == 'block' || item.mode == 'unconfigured', 'Invalid section mode.');
		check(type(item.enabled) == 'bool' && type(item.fallback) == 'bool', 'Invalid section state.');
		if (item.mode == 'unconfigured')
			check(!item.enabled && !item.fallback, 'Choose a section type before enabling it.');
		if (item.fallback) {
			check(item.mode != 'proxy_devices', 'A device-specific section cannot be the general default.');
			check(item.enabled, 'The default section must be enabled.');
			check(++defaults == 1, 'Only one section can handle unmatched traffic.');
		}
		check(type(item.domains) == 'array', 'Enter a list of destinations.');
		let source = item.domains;
		if (item.ips != null) { check(type(item.ips) == 'array', 'Enter a list of IP addresses.'); source = [ ...source, ...item.ips ]; }
		if (item.domains_text != null)
			source = split(text(item.domains_text, 131072, 'domain list text'), '\n');
		let domains = [], ips = [], seen = {};
		for (let value in source) {
			let entry = trim(split(text(value, 131072, 'destination'), '#')[0]);
			if (!length(entry)) continue;
			let domain = lc(text(entry, 253, 'destination'));
			if (index(domain, '/') >= 0 || index(domain, ':') >= 0 || match(domain, /^[0-9.]+$/)) {
				let ip = ipv4_destination(domain);
				if (seen[ip]) continue;
				seen[ip] = true;
				check(++domain_count <= 8192, 'A maximum of 8192 destinations is supported.');
				push(ips, ip); continue;
			}
			domain = replace(domain, /^\*\./, '');
			domain = replace(domain, /\.$/, '');
			check(length(domain) && !match(domain, /[^a-z0-9.-]/) && !match(domain, /^[0-9.]+$/), 'Enter a domain, IPv4 address or CIDR subnet, without URLs or paths.');
			for (let label in split(domain, '.'))
				check(length(label) <= 63 && match(label, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/), 'Invalid domain: ' + domain);
			if (seen[domain]) continue;
			seen[domain] = true;
			check(++domain_count <= 8192, 'A maximum of 8192 destinations is supported.');
			push(domains, domain);
		}
		let section = { id, name, mode: item.mode, enabled: item.enabled, fallback: item.fallback, domains };
		if (length(ips)) section.ips = ips;
		if (item.domains_text != null) section.domains_text = item.domains_text;
		if (item.mode == 'proxy_devices') {
			section.macs = device_macs(item.macs);
			check(!item.enabled || length(section.macs), 'Select at least one device for ' + name + '.');
			for (let mac in section.macs) {
				check(!assigned[mac], 'A device can only belong to one device-specific Xray section: ' + mac);
				check(++device_count <= 128, 'A maximum of 128 assigned devices is supported.');
				assigned[mac] = true;
			}
			section.domains = [];
			delete section.domains_text;
			delete section.ips;
		}
		if ((item.mode == 'proxy' || item.mode == 'proxy_devices') && (item.enabled || item.profile != null)) section.profile = proxy_profile(item.profile);
		push(sections, section);
	}
	return sections;
}


// IP-only protocols cannot carry domain names. TCP/UDP are deferred to Xray
// when an earlier domain rule might change the section which wins.
function firewall_policy(sections) {
	let lines = [
		'add chain inet krotex smart_policy',
		'add rule inet krotex smart_policy fib daddr type { local, broadcast, multicast } return',
		'add rule inet krotex smart_policy ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 } return',
		// Keep the existing public QUIC block in the capture chain authoritative.
		'add rule inet krotex smart_policy udp dport 443 return'
	];
	let domains_before = false, fallback = 'direct';
	for (let section in sections) {
		if (!section.enabled || section.mode == 'proxy_devices') continue;
		if (section.fallback) fallback = section.mode;
		if (length(section.ips || [])) {
			let rule = 'add rule inet krotex smart_policy ip daddr { ' + join(', ', section.ips) + ' }';
			if (domains_before) push(lines, rule + ' meta l4proto { tcp, udp } th dport != 53 return');
			if (section.mode == 'direct') push(lines, rule + ' counter accept');
			else if (section.mode == 'block') push(lines, rule + ' counter drop');
			else {
				push(lines, rule + ' meta l4proto != { tcp, udp } counter drop');
				push(lines, rule + ' return');
			}
		}
		if (length(section.domains)) domains_before = true;
	}
	push(lines, 'add rule inet krotex smart_policy meta l4proto != { tcp, udp } counter ' + (fallback == 'direct' ? 'accept' : 'drop'));
	return join('\n', lines) + '\n';
}

function compile(sections) {
	let rules = [{ type: 'field', inboundTag: ['device-dns'], outboundTag: 'device-dns-proxy' }];
	let outbounds = [], dns_profile = null, fallback = 'direct';
	let traffic = ['device-tproxy', 'local-socks'];
	let inbounds = [{ tag: 'local-socks', listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { auth: 'noauth', udp: false } }];
	for (let index, section in sections) {
		if (!section.enabled) continue;
		let tag = (section.mode == 'proxy' || section.mode == 'proxy_devices') ? 'section-' + section.id : section.mode == 'block' ? 'block' : 'direct';
		if (section.mode == 'proxy' || section.mode == 'proxy_devices') {
			push(outbounds, outbound(section.profile, tag));
			let check_tag = 'section-check-' + section.id;
			push(inbounds, { tag: check_tag, listen: '127.0.0.1', port: 11080 + index, protocol: 'socks', settings: { auth: 'noauth', udp: false } });
			push(rules, { type: 'field', inboundTag: [check_tag], outboundTag: tag });
			if (section.mode == 'proxy' && (!dns_profile || section.fallback)) dns_profile = section.profile;
		}
		if (section.mode == 'proxy_devices') {
			let inbound = 'device-section-' + section.id, dns = inbound + '-dns';
			for (let suffix, port in { traffic: 12080 + index, dns: 12112 + index })
				push(inbounds, { tag: suffix == 'traffic' ? inbound : dns, listen: '127.0.0.1', port,
					protocol: 'dokodemo-door', settings: { network: 'tcp,udp', followRedirect: true },
					streamSettings: { sockopt: { tproxy: 'tproxy' } } });
			push(outbounds, { tag: dns, protocol: 'freedom', settings: { redirect: '1.1.1.1:53' },
				streamSettings: { sockopt: { dialerProxy: tag } } });
			push(rules, { type: 'field', inboundTag: [inbound], outboundTag: tag });
			push(rules, { type: 'field', inboundTag: [dns], outboundTag: dns });
			continue;
		}
		if (section.fallback) fallback = tag;
		if (length(section.domains))
			push(rules, { type: 'field', inboundTag: traffic, domain: map(section.domains, d => 'domain:' + d), outboundTag: tag });
		if (length(section.ips || []))
			push(rules, { type: 'field', inboundTag: traffic, ip: section.ips, outboundTag: tag });
	}
	if (filter(sections, s => s.enabled && s.mode == 'block')[0])
		push(outbounds, { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'none' } } });
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
	else if (ARGV[0] == 'firewall')
		print(firewall_policy(normalize(current_sections(config))));
	else if (ARGV[0] == 'connections') {
		let entries = [], groups = {};
		for (let section in current_sections(config)) {
			if ((section.mode != 'proxy' && section.mode != 'proxy_devices') || !section.profile) continue;
			let profile = proxy_profile(section.profile);
			delete profile.url;
			profile.id = lc(profile.id); profile.address = lc(profile.address); profile.server_name = lc(profile.server_name);
			let key = sprintf('%J', profile);
			if (!groups[key]) {
				groups[key] = { id: section.id, endpoint: (index(profile.address, ':') >= 0 ? '[' + profile.address + ']' : profile.address) + ':' + profile.port, sections: [] };
				push(entries, groups[key]);
			}
			push(groups[key].sections, section.name);
		}
		printf('%J\n', { connections: entries });
	}
	else if (ARGV[0] == 'probe') {
		let request = json(readfile(ARGV[2], 262145)), found = false;
		for (let section in current_sections(config)) {
			if (section.id != request.id || (section.mode != 'proxy' && section.mode != 'proxy_devices') || !section.profile) continue;
			printf('%J\n', { log: { loglevel: 'warning' },
				inbounds: [{ tag: 'probe', listen: '127.0.0.1', port: 11180, protocol: 'socks', settings: { auth: 'noauth', udp: false } }],
				outbounds: [outbound(proxy_profile(section.profile), 'proxy')] });
			found = true; break;
		}
		check(found, 'Save a valid Xray connection before checking it.');
	}
	else if (ARGV[0] == 'devices') {
		let routes = [];
		for (let index, section in normalize(config.krotex_sections || []))
			if (section.enabled && section.mode == 'proxy_devices')
				push(routes, { macs: section.macs, port: 12080 + index, dns_port: 12112 + index });
		printf('%J\n', { routes });
	}
	else if (ARGV[0] == 'check') {
		let request = json(readfile(ARGV[2], 262145));
		let found = false;
		for (let index, section in config.krotex_sections || []) {
			if (section.id != request.id) continue;
			check(section.enabled && (section.mode == 'proxy' || section.mode == 'proxy_devices'), 'Choose an enabled Xray section.');
			printf('%J\n', { port: 11080 + index });
			found = true;
			break;
		}
		check(found, 'Save this Xray section before checking its connection.');
	}
	else if (ARGV[0] == 'routing') {
		let request = json(readfile(ARGV[2], 262145));
		check(type(request.routing) == 'string', 'Invalid device routing request.');
		let routing = json(request.routing);
		check(type(routing) == 'object' && (routing.mode == 'all' || routing.mode == 'selected'), 'Invalid routing mode.');
		check(type(routing.macs) == 'array' && length(routing.macs) <= 128, 'A maximum of 128 devices is supported.');
		let macs = [], seen = {};
		for (let value in routing.macs) {
			let mac = lc(text(value, 17, 'MAC address'));
			check(match(mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/) && mac != '00:00:00:00:00:00' && !match(mac, /^[0-9a-f][13579bdf]:/), 'Enter a valid unicast device MAC address.');
			if (!seen[mac]) { seen[mac] = true; push(macs, mac); }
		}
		printf('%J\n', { mode: routing.mode, macs, enabled: routing.mode == 'all' || length(macs) > 0 });
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

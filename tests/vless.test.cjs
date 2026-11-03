const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname,
  '../package/luci-app-krotex/htdocs/luci-static/resources/krotex/vless.js'), 'utf8');
class Baseclass {}
Baseclass.extend = function(properties) {
  class Module extends this {}
  Object.assign(Module.prototype, properties);
  return Module;
};
const context = vm.createContext({ URL, URLSearchParams, _: text => text, baseclass: Baseclass });
vm.runInContext("String.prototype.format = function(value) { return this.replace('%s', value); };", context);
const factory = vm.runInContext(`(function() { ${source}\n })()`, context);
function loadModule() {
  assert.equal(typeof factory, 'function', '"krotex.vless" factory yields invalid constructor');
  assert.ok(factory.prototype instanceof Baseclass, 'LuCI module must extend baseclass');
  return new factory();
}
const uuid = '11111111-2222-4333-8444-555555555555';
const prefix = `vless://${uuid}@proxy.example:443?`;

test('reconstructs saved TLS and REALITY profiles, including IPv6 and encoded parameters', () => {
  const parser = loadModule();
  for (const link of [
    prefix + 'security=reality&sni=example.com&pbk=' + 'A'.repeat(43) + '&sid=abcd&spx=%2Fpath%3Fhello%3Dworld&flow=xtls-rprx-vision',
    `vless://${uuid}@[2001:db8::1]:443?security=tls&sni=example.com&alpn=h2,http%2F1.1`
  ]) {
    const profile = parser.parse(link);
    assert.deepEqual(parser.parse(parser.format(profile)), profile);
  }
});

test('exports a constructor accepted by the LuCI module loader', () => {
  assert.equal(typeof loadModule().parse, 'function');
  assert.match(source, /'require baseclass';/);
});

test('imports a TCP REALITY Vision link', () => {
  const parser = loadModule();
  const profile = parser.parse(prefix + 'type=tcp&security=reality&encryption=none&sni=example.com&fp=chrome&pbk=' +
    'A'.repeat(43) + '&sid=abcdef&spx=%2Fhello&flow=xtls-rprx-vision#My%20server');
  assert.equal(profile.address, 'proxy.example');
  assert.equal(profile.id, uuid);
  assert.equal(profile.security, 'reality');
  assert.equal(profile.spider_x, '/hello');
  assert.equal(profile.flow, 'xtls-rprx-vision');
});

test('imports IPv6, TLS ALPN and raw transport alias', () => {
  const parser = loadModule();
  const profile = parser.parse(`vless://${uuid}@[2001:db8::1]:8443?type=raw&security=tls&sni=example.com&alpn=h2%2Chttp%2F1.1`);
  assert.equal(profile.address, '2001:db8::1');
  assert.equal(profile.port, 8443);
  assert.equal(profile.alpn, 'h2,http/1.1');
});

test('rejects malformed links and unsupported transport/security settings', () => {
  const parser = loadModule();
  for (const value of ['invalid', prefix.replace(uuid, 'invalid') + 'security=tls',
    prefix + 'security=none', prefix + 'security=tls&type=ws', prefix + 'security=tls&headerType=http',
    prefix + 'security=tls&security=reality',
    prefix + 'security=tls&encryption=custom', prefix + 'security=tls&flow=unknown',
    prefix + 'security=reality&sni=example.com',
    prefix + 'security=reality&sni=example.com&pbk=' + 'A'.repeat(43) + '&sid=abc'])
    assert.throws(() => parser.parse(value), undefined, value);
});

test('unknown parameters produce warnings without blocking a valid connection', () => {
  const parser = loadModule();
  const extra = encodeURIComponent(JSON.stringify({ tcp: [{ type: 'fragment', settings: { length: '10-20', packets: '1-3', interval: '10-20' } }] }));
  const link = prefix + 'security=reality&sni=proxy.example&fp=firefox&pbk=' + 'A'.repeat(43) + '&fm=' + extra;
  const result = parser.inspect(link);
  assert.deepEqual(Array.from(result.ignored), ['fm']);
  assert.equal(result.profile.fingerprint, 'firefox');
  assert.equal(result.profile.security, 'reality');
  assert.equal(result.profile.short_id, '');
  assert.equal(result.profile.fm, undefined);
  assert.equal(parser.parse(link).address, 'proxy.example');
});

test('unknown values cannot inject markup into warnings and duplicates still fail', () => {
  const parser = loadModule();
  const result = parser.inspect(prefix + 'security=tls&futureOption=%3Cscript%3E');
  assert.deepEqual(Array.from(result.ignored), ['futureOption']);
  assert.throws(() => parser.parse(prefix + 'security=tls&fm=a&fm=b'), /Repeated VLESS parameter/);
});

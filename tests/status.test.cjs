const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname,
  '../package/luci-app-krotex/htdocs/luci-static/resources/view/krotex/status.js'), 'utf8');

// Run the actual LuCI view with a minimal DOM and mocked RPC transport.
function harness(writable = true) {
  const state = {
    response: { available: true, installed: true, running: true, enabled: true,
      pid: 42, uptime: 3661, memory_kib: 2048, core_version: '26.10.21' },
    notifications: [], actions: [], pollers: [], code: 0, saved: [], connectionCode: 0, ignored: [],
    connection: { configured: false },
    routing: { enabled: false, active: false, macs: [] }, routingCalls: [], routingCode: 0
  };
  const context = vm.createContext({
    setTimeout: fn => fn(),
    E: (tag, attrs, children) => ({ tag, attrs, children, value: attrs.value || '', style: {}, textContent: '', scrollHeight: 320,
      replaceChildren(...items) { this.children = items; } }),
    _: text => text,
    vless: { inspect: value => {
      if (value !== 'vless://valid') throw new Error('Invalid link');
      return { profile: { id: 'test-uuid', address: 'proxy.example' }, ignored: state.ignored };
    }, format: () => 'vless://valid' },
    L: { bind: (fn, self, ...args) => fn.bind(self, ...args), hasViewPermission: () => writable },
    view: { extend: view => view },
    rpc: { declare: spec => async (action, enabled) => {
      if (spec.method === 'status') {
        if (state.offline) throw new Error('RPC offline');
        return state.response;
      }
      if (spec.method === 'connection') return state.connection;
      if (spec.method === 'save_connection') {
        state.saved.push(JSON.parse(action));
        return { code: state.connectionCode, message: 'Rejected' };
      }
      if (spec.method === 'test_connection') return { code: 0, ip: '203.0.113.2' };
      if (spec.method === 'devices') return { devices: [{ name: 'Phone', address: '192.168.1.10', mac: '02:11:22:33:44:55' }] };
      if (spec.method === 'routing') return state.routing;
      if (spec.method === 'set_routing') {
        state.routingCalls.push({ mac: action, enabled });
        if (!state.routingCode) {
          const macs = state.routing.macs.filter(mac => mac !== action);
          if (enabled) macs.push(action);
          state.routing = { macs, enabled: macs.length > 0, active: macs.length > 0 };
        }
        return { code: state.routingCode, message: 'Routing rejected' };
      }
      state.actions.push(action);
      return { code: state.code };
    } },
    poll: { add: (fn, interval) => state.pollers.push({ fn, interval }) },
    ui: { createHandlerFn: (self, name, action) => () => self[name](action),
      addNotification: (_, element) => state.notifications.push(element) }
  });
  vm.runInContext(`String.prototype.format = function(...args) {
    let i = 0;
    return this.replace(/%s|%\\.1f/g, token => token === '%.1f'
      ? Number(args[i++]).toFixed(1) : String(args[i++]));
  };`, context);
  state.view = vm.runInContext(`(function() { ${source}\n })()`, context);
  state.view.render(state.response);
  return state;
}

test('shows process metrics and polls every five seconds', () => {
  const { view, pollers } = harness();
  assert.equal(view.fields.status.textContent, 'Running');
  assert.equal(view.fields.core_version.textContent, '26.10.21');
  assert.equal(view.fields.uptime.textContent, '01:01:01');
  assert.equal(view.fields.memory.textContent, '2.0 MiB');
  assert.equal(view.fields.pid.textContent, '42');
  assert.equal(pollers[0].interval, 5);
});

test('clears stale process metrics when stopped', async () => {
  const state = harness();
  state.response = { available: true, installed: true, running: false, enabled: false };
  await state.pollers[0].fn();
  assert.equal(state.view.fields.status.textContent, 'Stopped');
  assert.equal(state.view.fields.enabled.textContent, 'Disabled');
  for (const field of ['pid', 'uptime', 'memory'])
    assert.equal(state.view.fields[field].textContent, '—');
});

test('RPC failure shows unknown status and recovers on the next poll', async () => {
  const state = harness();
  state.offline = true;
  await state.view.refresh();
  assert.equal(state.view.fields.status.textContent, 'Status unavailable');
  assert.ok(state.view.buttons.every(button => button.disabled));
  state.offline = false;
  await state.view.refresh();
  assert.equal(state.view.fields.status.textContent, 'Running');
  assert.ok(state.view.buttons.every(button => !button.disabled));
});

test('read-only users cannot operate service buttons', () => {
  assert.ok(harness(false).view.buttons.every(button => button.disabled));
});

test('initial RPC failure still allows rendering a page that can recover', async () => {
  const state = harness();
  state.offline = true;
  const data = await state.view.load();
  assert.equal(data.available, false);
  state.view.render(data);
  assert.equal(state.view.fields.status.textContent, 'Status unavailable');
  state.offline = false;
  await state.view.refresh();
  assert.equal(state.view.fields.status.textContent, 'Running');
});

test('failed service command notifies the user and releases controls', async () => {
  const state = harness();
  state.code = 1;
  const action = state.view.handleAction('start');
  assert.ok(state.view.buttons.every(button => button.disabled));
  await action;
  assert.deepEqual(state.actions, ['start']);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.view.busy, false);
  assert.ok(state.view.buttons.every(button => !button.disabled));
});

test('applying a link sends a profile and keeps the link visible', async () => {
  const state = harness();
  state.view.connectionInput.value = 'vless://valid';
  await state.view.handleConnection('save');
  assert.deepEqual(state.saved, [{ id: 'test-uuid', address: 'proxy.example', url: 'vless://valid' }]);
  assert.equal(state.view.connectionInput.value, 'vless://valid');
  assert.equal(state.view.connectionResult.textContent, 'Connection saved and applied.');
  assert.equal(state.view.busy, false);
});

test('link editor is a visible multiline text area', () => {
  const { view } = harness();
  assert.equal(view.connectionInput.tag, 'textarea');
  assert.equal(view.connectionInput.attrs.type, undefined);
  assert.ok(Number(view.connectionInput.attrs.rows) > 1);
});

test('ignored parameters appear below the link while typing and do not block saving', async () => {
  const state = harness();
  state.ignored = ['fm'];
  state.view.connectionInput.value = 'vless://valid';
  state.view.connectionInput.attrs.input();
  assert.equal(state.view.connectionWarning.textContent, 'Ignored parameters (not applied): fm');
  await state.view.handleConnection('save');
  assert.equal(state.saved.length, 1);
  assert.equal(state.view.connectionWarning.textContent, 'Ignored parameters (not applied): fm');
  state.view.connectionInput.value = '';
  state.view.connectionInput.attrs.input();
  assert.equal(state.view.connectionWarning.textContent, '');
});

test('invalid link is rejected before RPC and failed saves keep the input', async () => {
  const state = harness();
  state.view.connectionInput.value = 'not a link';
  await state.view.handleConnection('save');
  assert.equal(state.saved.length, 0);
  state.view.connectionInput.value = 'vless://valid';
  state.connectionCode = 1;
  await state.view.handleConnection('save');
  assert.equal(state.view.connectionInput.value, 'vless://valid');
  assert.equal(state.view.connectionResult.textContent, 'Rejected');
});

test('connection check displays the exit IP', async () => {
  const state = harness();
  await state.view.handleConnection('test');
  assert.equal(state.view.connectionResult.textContent, 'Connection successful. Exit IP: 203.0.113.2');
});

test('DHCP selection immediately adds a device to the visible routing list', async () => {
  const state = harness();
  await state.view.refreshDevices();
  assert.equal(state.view.deviceSelect.children.length, 2);
  state.view.deviceSelect.value = '02:11:22:33:44:55';
  await state.view.deviceSelect.attrs.change();
  assert.deepEqual(state.routingCalls, [{ mac: '02:11:22:33:44:55', enabled: true }]);
  assert.equal(state.view.busy, false);
  assert.equal(state.view.routingList.children.length, 1);
  assert.match(state.view.routingList.children[0].children[0].children, /Phone/);
});

test('invalid MAC does not reach RPC and backend routing failure is displayed', async () => {
  const state = harness();
  state.view.routingMac.value = 'invalid';
  await state.view.handleRouting(true);
  assert.equal(state.routingCalls.length, 0);
  state.view.routingMac.value = '02:11:22:33:44:55';
  state.routingCode = 1;
  await state.view.handleRouting(true);
  assert.equal(state.view.routingResult.textContent, 'Routing rejected');
  assert.equal(state.view.busy, false);
});

test('adding two devices preserves both, and the cross removes only its own device', async () => {
  const state = harness();
  await state.view.handleRouting(true, '02:11:22:33:44:55');
  await state.view.handleRouting(true, '02:aa:bb:cc:dd:ee');
  assert.equal(state.view.routingList.children.length, 2);
  state.view.routingMac.value = 'invalid';
  await state.view.routingRemoveButtons[0].attrs.click();
  assert.deepEqual(state.routing.macs, ['02:aa:bb:cc:dd:ee']);
  assert.equal(state.view.routingList.children.length, 1);
  await state.view.routingRemoveButtons[0].attrs.click();
  assert.equal(state.routing.enabled, false);
  assert.equal(state.view.routingList.children[0].children, 'No devices added');
});

test('opening the page restores the saved link and sizes the textbox to all content', async () => {
  const state = harness();
  state.connection = { configured: true, link: 'vless://valid', address: 'proxy.example', port: 443, security: 'reality' };
  await state.view.refreshConnection();
  assert.equal(state.view.connectionInput.value, 'vless://valid');
  assert.equal(state.view.connectionInput.style.height, '320px');
  state.view.connectionInput.value = 'unfinished edit';
  state.view.connectionInput.attrs.input();
  await state.view.refreshConnection();
  assert.equal(state.view.connectionInput.value, 'unfinished edit');
});

test('older connections without an original link are reconstructed', async () => {
  const state = harness();
  state.connection = { configured: true, profile: {}, address: 'proxy.example', port: 443, security: 'tls' };
  await state.view.refreshConnection();
  assert.equal(state.view.connectionInput.value, 'vless://valid');
});

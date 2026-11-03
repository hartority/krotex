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
    notifications: [], actions: [], pollers: [], code: 0, saved: [], connectionCode: 0, ignored: []
  };
  const context = vm.createContext({
    E: (tag, attrs, children) => ({ tag, attrs, children, style: {}, textContent: '' }),
    _: text => text,
    vless: { inspect: value => {
      if (value !== 'vless://valid') throw new Error('Invalid link');
      return { profile: { id: 'test-uuid', address: 'proxy.example' }, ignored: state.ignored };
    } },
    L: { bind: (fn, self, ...args) => fn.bind(self, ...args), hasViewPermission: () => writable },
    view: { extend: view => view },
    rpc: { declare: spec => async action => {
      if (spec.method === 'status') {
        if (state.offline) throw new Error('RPC offline');
        return state.response;
      }
      if (spec.method === 'connection') return { configured: false };
      if (spec.method === 'save_connection') {
        state.saved.push(JSON.parse(action));
        return { code: state.connectionCode, message: 'Rejected' };
      }
      if (spec.method === 'test_connection') return { code: 0, ip: '203.0.113.2' };
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
  assert.deepEqual(state.saved, [{ id: 'test-uuid', address: 'proxy.example' }]);
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

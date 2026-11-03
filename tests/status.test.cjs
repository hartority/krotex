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
      pid: 42, uptime: 3661, memory_kib: 2048, core_version: '26.10.21', krotex_version: '0.8.1' },
    notifications: [], actions: [], pollers: [], code: 0,
    routing: { enabled: false, active: false, mode:'selected', macs: [] }, routingCalls: [], routingModeCalls: [], routingCode: 0, settingsCalls: [], draftSections: [], savedSections: []
  };
  const context = vm.createContext({
    setTimeout: fn => fn(),
    E: (tag, attrs, children) => ({ tag, attrs, children, value: attrs.value || '', style: {}, textContent: '', scrollHeight: 320,
      replaceChildren(...items) { this.children = items; }, setAttribute(key,value) { this.attrs[key]=value; } }),
    _: text => text,
    sections: { create: () => ({
      render: () => ({}), setState: () => {}, loaded:true, dirty:false,
      saveButton:{}, resetButton:{}, result:{textContent:''},
      serialize:()=>state.draftSections,
      load:async()=>{state.draftSections=structuredClone(state.savedSections);state.view.sectionsEditor.dirty=false;}
    }) },
    L: { bind: (fn, self, ...args) => fn.bind(self, ...args), hasViewPermission: () => writable },
    view: { extend: view => view },
    rpc: { declare: spec => async (action, enabled) => {
      if (spec.method === 'status') {
        if (state.offline) throw new Error('RPC offline');
        return state.response;
      }
      if (spec.method === 'devices') return { devices: [{ name: 'Phone', address: '192.168.1.10', mac: '02:11:22:33:44:55' }] };
      if (spec.method === 'routing') return state.routing;
      if (spec.method === 'save_settings') {
        state.settingsCalls.push({sections:JSON.parse(action),routing:JSON.parse(enabled)});
        if (!state.routingCode) {
          state.savedSections=JSON.parse(action);
          const routing=JSON.parse(enabled);
          state.routing={...routing,enabled:routing.mode==='all'||routing.macs.length>0,active:routing.mode==='all'||routing.macs.length>0};
        }
        return {code:state.routingCode,message:'Settings rejected'};
      }
      if (spec.method === 'set_routing_mode') {
        state.routingModeCalls.push(action);
        if (!state.routingCode) state.routing={...state.routing,mode:action,enabled:action==='all'||state.routing.macs.length>0,active:action==='all'||state.routing.macs.length>0};
        return {code:state.routingCode,message:'Routing rejected'};
      }
      if (spec.method === 'set_routing') {
        state.routingCalls.push({ mac: action, enabled });
        if (!state.routingCode) {
          const macs = state.routing.macs.filter(mac => mac !== action);
          if (enabled) macs.push(action);
          const mode=state.routing.mode||'selected';
          state.routing = { mode,macs, enabled: mode==='all'||macs.length > 0, active: mode==='all'||macs.length > 0 };
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
  assert.equal(view.fields.krotex_version.textContent, '0.8.1');
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







test('DHCP selection stages a device without changing saved routing', async () => {
  const state=harness(),view=state.view;await view.refreshRouting();await view.refreshDevices();
  view.deviceSelect.value='02:11:22:33:44:55';await view.deviceSelect.attrs.change();
  assert.deepEqual(state.routingCalls,[]);assert.equal(state.settingsCalls.length,0);
  assert.equal(view.routingMacs.length,1);assert.equal(view.routingDirty,true);
  assert.equal(state.routing.macs.length,0);
  assert.equal(view.routingList.children[0].children[0].children[0].children,'Phone');
});

test('mode and device drafts survive polling and apply together in one request',async()=>{
  const state=harness(),view=state.view;await view.refreshRouting();
  await view.handleRouting(true,'02:11:22:33:44:55');
  view.routingMode.value='all';await view.handleRoutingMode();
  await view.refresh();
  assert.equal(view.routingMode.value,'all');assert.equal(view.routingMacs.length,1);
  assert.equal(view.deviceSelection.style.display,'none');
  assert.equal(state.routing.mode,'selected');assert.equal(state.settingsCalls.length,0);
  state.draftSections=[{name:'VPN draft'}];view.sectionsEditor.dirty=true;
  await view.handleSettingsSave();
  assert.equal(state.settingsCalls.length,1);
  assert.equal(state.settingsCalls[0].sections[0].name,'VPN draft');
  assert.equal(state.routing.mode,'all');assert.equal(state.routing.macs.length,1);
  assert.equal(view.routingDirty,false);assert.equal(view.sectionsEditor.dirty,false);
});

test('failed combined save retains both drafts for retry',async()=>{
  const state=harness(),view=state.view;await view.refreshRouting();
  await view.handleRouting(true,'02:11:22:33:44:55');
  state.draftSections=[{name:'VPN draft'}];view.sectionsEditor.dirty=true;state.routingCode=1;
  await view.handleSettingsSave();
  assert.equal(view.routingMacs.length,1);assert.equal(view.routingDirty,true);
  assert.equal(view.sectionsEditor.dirty,true);assert.equal(state.draftSections[0].name,'VPN draft');
  assert.equal(state.routing.macs.length,0);assert.equal(view.sectionsEditor.result.textContent,'Settings rejected');
  assert.equal(view.busy,false);
});

test('Reset restores sections and routing without writing settings',async()=>{
  const state=harness(),view=state.view;await view.refreshRouting();
  await view.handleRouting(true,'02:11:22:33:44:55');
  view.routingMode.value='all';await view.handleRoutingMode();
  state.savedSections=[{name:'Saved VPN'}];state.draftSections=[{name:'Draft VPN'}];view.sectionsEditor.dirty=true;
  await view.handleSettingsReset();
  assert.equal(view.routingMacs.length,0);assert.equal(view.routingMode.value,'selected');
  assert.equal(view.routingDirty,false);assert.equal(view.sectionsEditor.dirty,false);
  assert.equal(state.draftSections[0].name,'Saved VPN');assert.equal(state.settingsCalls.length,0);
});

test('invalid MACs never enter the draft and duplicate devices are ignored',async()=>{
  const state=harness(),view=state.view;await view.refreshRouting();
  for(const mac of ['invalid','00:00:00:00:00:00','01:11:22:33:44:55'])await view.handleRouting(true,mac);
  assert.equal(view.routingMacs.length,0);assert.equal(state.notifications.length,3);
  await view.handleRouting(true,'02:11:22:33:44:55');await view.handleRouting(true,'02:11:22:33:44:55');
  assert.equal(view.routingMacs.length,1);assert.equal(state.settingsCalls.length,0);
});

test('remove stages only its own device and Reset restores the saved list',async()=>{
  const state=harness(),view=state.view;
  state.routing={mode:'selected',macs:['02:11:22:33:44:55','02:aa:bb:cc:dd:ee'],enabled:true,active:true};
  await view.refreshRouting(true);
  await view.routingRemoveButtons[0].attrs.click();
  assert.deepEqual(Array.from(view.routingMacs),['02:aa:bb:cc:dd:ee']);
  assert.equal(state.routing.macs.length,2);
  await view.handleSettingsReset();assert.equal(view.routingMacs.length,2);
});

test('read-only callers cannot stage or save routing',async()=>{
  const state=harness(false),view=state.view;await view.refreshRouting();
  await view.handleRouting(true,'02:11:22:33:44:55');await view.handleSettingsSave();
  assert.equal(view.routingMacs.length,0);assert.equal(state.settingsCalls.length,0);
});

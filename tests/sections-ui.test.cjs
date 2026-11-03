const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {test}=require('node:test');
const vm=require('node:vm');
const root='../package/luci-app-krotex/htdocs/luci-static/resources/krotex/';
const link='vless://11111111-2222-4333-8444-555555555555@proxy.example:443?security=tls&sni=example.com&fm=ignored#Name';
function harness(writable=true){
  const state={sections:[{id:'vpn1',name:'VPN 1',mode:'proxy',enabled:true,fallback:true,domains:[],profile:{url:link}}],saved:[],checks:[],code:0,busy:[]};
  class Baseclass{}
  Baseclass.extend=props=>{class Module extends Baseclass{}; Object.assign(Module.prototype,props);return Module;};
  const ctx=vm.createContext({URL,URLSearchParams,baseclass:Baseclass,Math,Date,setTimeout:fn=>fn(),_:s=>s,
    E:(tag,attrs,children)=>({tag,attrs,children,value:attrs.value||'',style:{},textContent:'',scrollHeight:320,offsetHeight:102,clientHeight:100,
      replaceChildren(...items){this.children=items;}}),
    L:{bind:(fn,self,...args)=>fn.bind(self,...args),hasViewPermission:()=>writable},
    ui:{addNotification:()=>{}},rpc:{declare:spec=>async(value)=>{
      if(spec.method==='sections')return {sections:state.sections};
      if(spec.method==='test_section'){state.checks.push(value);return {code:state.testCode||0,ip:'203.0.113.10',latency_ms:124,message:'Proxy connection failed'};}
      const data=JSON.parse(value);state.saved.push(data);
      if(!state.code)state.sections=data;
      return {code:state.code,message:'Rejected'};
    }}});
  vm.runInContext("String.prototype.format=function(...a){let i=0;return this.replace(/%s/g,()=>String(a[i++]));};",ctx);
  for(const name of ['vless','devicecard','sections']){
    const source=readFileSync(resolve(__dirname,root+name+'.js'),'utf8');
    const Factory=vm.runInContext('(function(){'+source+'\n})()',ctx);
    ctx[name]=new Factory();
  }
  state.editor=ctx.sections.create({onBusy:busy=>state.busy.push(busy)});
  state.editor.render();state.editor.setState(false,true);
  return state;
}
function controls(editor,label){return editor.controls.filter(c=>c.attrs['aria-label']===label);}
function chooseMode(editor,index,value){controls(editor,'Section route')[index].attrs.change({target:{value}});}

test('section editor restores the entire link, warnings and textbox height',async()=>{
  const {editor}=harness();await editor.load();
  assert.equal(controls(editor,'VLESS link').length,0);
  controls(editor,'Change VLESS connection')[0].attrs.click();
  const input=controls(editor,'VLESS link')[0];
  assert.equal(input.value,link);assert.equal(input.style.height,'322px');
  assert.equal(editor.sections[0].url,link);
  assert.ok(editor.controls.every(c=>!c.disabled||c.krotexBoundary||c===editor.saveButton||c===editor.resetButton));
});
test('section editor adds, orders and saves exclude/VPN1/VPN2 with one default',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  editor.add();chooseMode(editor,1,'direct');editor.sections[1].name='exclude';editor.sections[1].domains='example.com\n# comment\n';editor.move(1,-1);
  editor.add();chooseMode(editor,2,'proxy');editor.sections[2].url=link;editor.sections[2].name='VPN 2';
  editor.fallbackSelect.value=editor.sections[2].id;editor.handleFallbackChange();
  assert.deepEqual(Array.from(editor.sections,s=>s.fallback),[false,false,true]);
  await editor.save();
  assert.deepEqual(state.saved[0].map(s=>s.name),['exclude','VPN 1','VPN 2']);
  assert.deepEqual(state.saved[0][0].domains,['example.com']);
  assert.equal(state.saved[0][2].profile.url,link);
  assert.equal(editor.dirty,false);assert.equal(editor.saving,false);
  assert.deepEqual(state.busy,[true,false]);
});
test('section editor retains unsaved changes on rejection and blocks invalid links',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  controls(editor,'Change VLESS connection')[0].attrs.click();
  editor.sections[0].url='invalid';editor.changed();await editor.save();
  assert.equal(state.saved.length,0);assert.match(editor.result.textContent,/VPN 1:/);
  editor.sections[0].url=link;state.code=1;await editor.save();
  assert.equal(editor.sections[0].url,link);assert.equal(editor.dirty,true);
  assert.equal(editor.result.textContent,'Rejected');assert.equal(editor.saving,false);
});
test('section checks target their own saved VPN and cannot test unsaved edits',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  await editor.test(editor.sections[0]);
  assert.deepEqual(state.checks,['vpn1']);assert.match(editor.checkOutputs.vpn1.textContent,/203.0.113.10/);
  assert.match(editor.checkOutputs.vpn1.textContent,/Latency: 124 ms/);
  editor.changed();await editor.test(editor.sections[0]);
  assert.equal(state.checks.length,1);assert.match(editor.checkOutputs.vpn1.textContent,/Save settings/);
});

test('connection results stay inside their own section and errors are red',async()=>{
  const state=harness(),editor=state.editor;
  state.sections.push({...state.sections[0],id:'vpn2',name:'VPN 2',fallback:false});
  await editor.load();
  const globalMessage=editor.result.textContent;
  await editor.test(editor.sections[0]);
  const firstResult=editor.checkOutputs.vpn1.textContent;
  state.testCode=1;
  await editor.test(editor.sections[1]);
  assert.equal(editor.checkOutputs.vpn1.textContent,firstResult);
  assert.equal(editor.checkOutputs.vpn2.textContent,'Proxy connection failed');
  assert.equal(editor.checkOutputs.vpn2.style.color,'#d93025');
  assert.equal(editor.result.textContent,globalMessage);
});

test('Reset discards section edits, additions and deletions without saving',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  editor.sections[0].name='Edited';editor.sections[0].url='invalid';editor.add();editor.remove(0);
  assert.equal(editor.dirty,true);
  await editor.reset();
  assert.equal(editor.sections.length,1);
  assert.equal(editor.sections[0].id,'vpn1');assert.equal(editor.sections[0].name,'VPN 1');
  assert.equal(editor.sections[0].url,link);assert.equal(editor.dirty,false);
  assert.equal(state.saved.length,0);assert.deepEqual(state.busy,[true,false]);
  assert.equal(editor.resetButton.disabled,true);
});
test('disabled default is cleared; removal leaves the remaining section in place',async()=>{
  const {editor}=harness();await editor.load();
  assert.equal(editor.fallbackSelect.value,'vpn1');
  controls(editor,'Enable section')[0].attrs.change({target:{checked:false}});
  assert.equal(editor.sections[0].enabled,false);assert.equal(editor.sections[0].fallback,false);
  assert.equal(editor.fallbackSelect.value,'');
  editor.add();chooseMode(editor,1,'direct');editor.remove(0);assert.equal(editor.sections.length,1);assert.equal(editor.sections[0].mode,'direct');
});

test('one default-route selector tracks names, ordering, removal and Reset',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  assert.equal(editor.fallbackSelect.value,'vpn1');
  editor.add();
  assert.equal(editor.fallbackSelect.children.length,2,'unconfigured draft must not be an option');
  chooseMode(editor,1,'direct');
  assert.equal(editor.fallbackSelect.children.length,3);
  editor.fallbackSelect.value=editor.sections[1].id;editor.handleFallbackChange();
  assert.deepEqual(Array.from(editor.sections,s=>s.fallback),[false,true]);
  controls(editor,'Section name')[1].attrs.input({target:{value:'exclude'}});
  assert.match(editor.fallbackSelect.children[2].children,/exclude/);
  const selected=editor.sections[1].id;editor.move(1,-1);
  assert.equal(editor.fallbackSelect.value,selected);
  editor.remove(0);
  assert.equal(editor.fallbackSelect.value,'');
  assert.equal(editor.sections[0].fallback,false);
  await editor.reset();
  assert.equal(editor.fallbackSelect.value,'vpn1');
  editor.fallbackSelect.value='';editor.handleFallbackChange();
  await editor.save();
  assert.equal(state.saved[0][0].fallback,false);
  assert.equal(editor.fallbackSelect.value,'');
});
test('read-only users can view sections but cannot edit or save them',async()=>{
  const state=harness(false),editor=state.editor;await editor.load();
  assert.ok(editor.controls.every(c=>c.disabled));editor.add();editor.remove(0);await editor.save();
  assert.equal(editor.sections.length,1);assert.equal(state.saved.length,0);
});

test('new sections remain unconfigured and inactive across saving and reopening',async()=>{
  const state=harness(),editor=state.editor;await editor.load();editor.add();
  assert.equal(editor.sections[1].mode,'unconfigured');
  assert.equal(editor.sections[1].enabled,false);
  assert.equal(controls(editor,'Section route')[1].value,'unconfigured');
  assert.equal(controls(editor,'Enable section')[1].disabled,true);
  await editor.save();
  assert.equal(state.saved[0][1].mode,'unconfigured');
  assert.equal(editor.sections[1].mode,'unconfigured');
  chooseMode(editor,1,'direct');
  assert.equal(editor.sections[1].enabled,true);
  assert.equal(controls(editor,'Enable section')[1].disabled,false);
});

test('route selector and VLESS field stay consistent when changing types repeatedly',async()=>{
  const {editor}=harness();await editor.load();
  controls(editor,'Change VLESS connection')[0].attrs.click();
  chooseMode(editor,0,'direct');
  assert.equal(controls(editor,'Section route')[0].value,'direct');
  assert.equal(controls(editor,'VLESS link').length,0);
  chooseMode(editor,0,'proxy');
  assert.equal(controls(editor,'Section route')[0].value,'proxy');
  assert.equal(controls(editor,'VLESS link')[0].value,link);
  chooseMode(editor,0,'unconfigured');
  assert.equal(editor.sections[0].enabled,false);
  assert.equal(editor.sections[0].fallback,false);
  chooseMode(editor,0,'proxy');
  assert.equal(controls(editor,'VLESS link')[0].value,link);
});

test('opening connection editing changes no settings and Reset returns to the compact view',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  controls(editor,'Change VLESS connection')[0].attrs.click();
  assert.equal(editor.dirty,false);assert.equal(state.saved.length,0);
  assert.equal(editor.resetButton.disabled,false);
  await editor.reset();
  assert.equal(controls(editor,'VLESS link').length,0);
  assert.equal(controls(editor,'Change VLESS connection').length,1);
  assert.equal(state.saved.length,0);
});

test('failed saves retain the open VLESS editor; successful saves collapse it',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  controls(editor,'Change VLESS connection')[0].attrs.click();
  const changed=link.replace('proxy.example:443','new.example:8443');
  const input=controls(editor,'VLESS link')[0];input.value=changed;input.attrs.input({target:input});
  state.code=1;await editor.save();
  assert.equal(controls(editor,'VLESS link')[0].value,changed);
  state.code=0;await editor.save();
  assert.equal(controls(editor,'VLESS link').length,0);
  assert.equal(editor.sections[0].url,changed);
  assert.equal(state.saved[1][0].editingConnection,undefined);
});


test('Cancel closes VLESS editing without saving and restores only the link',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  controls(editor,'Change VLESS connection')[0].attrs.click();
  assert.equal(editor.dirty,false);
  controls(editor,'Cancel VLESS editing')[0].attrs.click();
  assert.equal(controls(editor,'VLESS link').length,0);
  assert.equal(editor.dirty,false);
  controls(editor,'Change VLESS connection')[0].attrs.click();
  controls(editor,'VLESS link')[0].attrs.input({target:{value:'invalid'}});
  controls(editor,'Section name')[0].attrs.input({target:{value:'Renamed VPN'}});
  controls(editor,'Cancel VLESS editing')[0].attrs.click();
  assert.equal(editor.sections[0].url,link);
  assert.equal(editor.sections[0].name,'Renamed VPN');
  assert.equal(editor.dirty,true);
  assert.equal(controls(editor,'VLESS link').length,0);
  assert.equal(state.saved.length,0);
});

test('Cancel discards link-only edits and respects read-only state',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  controls(editor,'Change VLESS connection')[0].attrs.click();
  controls(editor,'VLESS link')[0].attrs.input({target:{value:'invalid'}});
  editor.setState(true,true);
  assert.equal(controls(editor,'Cancel VLESS editing')[0].disabled,true);
  editor.setState(false,true);
  controls(editor,'Cancel VLESS editing')[0].attrs.click();
  assert.equal(editor.sections[0].url,link);
  assert.equal(editor.dirty,false);
  assert.equal(editor.saveButton.disabled,true);
  assert.equal(state.saved.length,0);
});


test('Block configures domains without VLESS and saves through the shared section model',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  editor.add();chooseMode(editor,1,'block');
  assert.equal(editor.sections[1].enabled,true);
  assert.equal(controls(editor,'Section route')[1].value,'block');
  assert.equal(controls(editor,'VLESS link').length,0);
  controls(editor,'Routing destinations')[1].attrs.input({target:{value:'blocked.example'}});
  editor.fallbackSelect.value=editor.sections[1].id;editor.handleFallbackChange();
  assert.equal(editor.sections[1].fallback,true);
  assert.match(editor.fallbackSelect.children[2].children,/Block/);
  await editor.save();
  assert.equal(state.saved[0][1].mode,'block');
  assert.deepEqual(state.saved[0][1].domains,['blocked.example']);
  assert.equal(state.saved[0][1].profile,undefined);
  assert.equal(controls(editor,'Section route')[1].value,'block');
});


test('domain comments, blank lines and spacing survive save and reload',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  const source='#ip-api.com\n\n  # temporarily disabled\nExample.com\n  youtube.com  \n';
  controls(editor,'Routing destinations')[0].attrs.input({target:{value:source}});
  await editor.save();
  assert.equal(state.saved[0][0].domains_text,source);
  assert.equal(editor.sections[0].domains,source);
  assert.equal(controls(editor,'Routing destinations')[0].value,source);
});


test('device VPN cards are separate, persist assigned devices and never become a common default',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  editor.setDevices([{name:'TV',address:'192.168.1.20',mac:'02:11:22:33:44:55'}]);
  editor.addDeviceVpn();const device=editor.sections[1];device.url=link;
  editor.assignDevice(device,'02:11:22:33:44:55');
  assert.equal(editor.deviceCards.children.length,1);assert.equal(editor.cards.children.length,1);
  assert.equal(controls(editor,'Move section up').length,2);
  assert.equal(controls(editor,'Section route').length,2);
  assert.equal(controls(editor,'Section route')[1].value,'proxy');
  assert.equal(controls(editor,'Section route')[1].disabled,true);
  chooseMode(editor,1,'block');assert.equal(device.mode,'proxy_devices');
  assert.equal(controls(editor,'Routing destinations').length,1);
  assert.equal(editor.fallbackSelect.children.length,2);
  await editor.save();
  assert.equal(state.saved[0][1].mode,'proxy_devices');
  assert.deepEqual(state.saved[0][1].macs,['02:11:22:33:44:55']);
  assert.equal(editor.deviceCards.children.length,1);
  editor.addDeviceVpn();editor.assignDevice(editor.sections[2],'02:11:22:33:44:55');
  assert.match(editor.result.textContent,/already belongs/);
  assert.equal(editor.sections[2].macs.length,0);
  await editor.reset();
  assert.equal(editor.sections.length,2);
});

test('general ordering skips device VPN cards and cancellation preserves device changes',async()=>{
  const {editor}=harness();await editor.load();editor.addDeviceVpn();editor.sections[1].url=link;
  editor.add();chooseMode(editor,2,'direct');
  const device=editor.sections[1];editor.move(2,-1);
  assert.equal(editor.sections[0].mode,'direct');assert.equal(editor.sections[1],device);
  assert.equal(editor.sections[2].mode,'proxy');
  editor.move(1,-1);assert.equal(editor.sections[1],device);
});


test('device VPN ordering stays within its own group and survives saving',async()=>{
  const {editor}=harness();await editor.load();
  editor.addDeviceVpn();editor.sections[1].url=link;editor.sections[1].macs=['02:11:22:33:44:55'];
  editor.add();chooseMode(editor,2,'direct');const general=editor.sections[2];
  editor.addDeviceVpn();editor.sections[3].url=link;editor.sections[3].macs=['02:aa:bb:cc:dd:ee'];
  const first=editor.sections[1],second=editor.sections[3];
  editor.move(3,-1);
  assert.equal(editor.sections[1],second);assert.equal(editor.sections[2],general);assert.equal(editor.sections[3],first);
  assert.equal(editor.fallbackSelect.value,'vpn1');
  await editor.save();
  assert.equal(editor.sections[1].id,second.id);assert.equal(editor.sections[3].id,first.id);
  assert.ok(controls(editor,'Section route').filter(c=>c.krotexBoundary).every(c=>c.disabled&&c.value==='proxy'));
});


test('the destinations editor preserves mixed IP rules and loads older IP metadata',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  const source='# paused\nexample.com\n1.2.3.4\n8.8.8.0/24\n';
  controls(editor,'Routing destinations')[0].attrs.input({target:{value:source}});
  await editor.save();
  assert.equal(editor.sections[0].domains,source);
  assert.deepEqual(state.saved[0][0].domains,['example.com','1.2.3.4','8.8.8.0/24']);
  state.sections[0].ips=['9.9.9.0/24'];state.sections[0].domains=['example.com'];delete state.sections[0].domains_text;
  await editor.load();assert.equal(controls(editor,'Routing destinations')[0].value,'example.com\n9.9.9.0/24');
});


test('inline destination comments survive saves while serialized destinations contain only addresses',async()=>{
  const state=harness(),editor=state.editor;await editor.load();
  const source='14.44.11.11 # CDN prod\n8.8.8.0/24 # subnet\nexample.com # site\n# disabled\n';
  controls(editor,'Routing destinations')[0].attrs.input({target:{value:source}});
  await editor.save();
  assert.equal(editor.sections[0].domains,source);
  assert.equal(state.saved[0][0].domains_text,source);
  assert.deepEqual(state.saved[0][0].domains,['14.44.11.11','8.8.8.0/24','example.com']);
});

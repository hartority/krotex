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
      if(spec.method==='test_section'){state.checks.push(value);return {code:state.testCode||0,ip:'203.0.113.10',message:'Proxy connection failed'};}
      const data=JSON.parse(value);state.saved.push(data);
      if(!state.code)state.sections=data;
      return {code:state.code,message:'Rejected'};
    }}});
  vm.runInContext("String.prototype.format=function(...a){let i=0;return this.replace(/%s/g,()=>String(a[i++]));};",ctx);
  for(const name of ['vless','sections']){
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
  editor.changed();await editor.test(editor.sections[0]);
  assert.equal(state.checks.length,1);assert.match(editor.checkOutputs.vpn1.textContent,/Save sections/);
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

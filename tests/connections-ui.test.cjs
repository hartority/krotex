const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
function harness(writable=true) {
  const state={calls:[],busy:[],writable,entries:[{id:'a',endpoint:'one.example:443',sections:['VPN 1','TV']},{id:'b',endpoint:'two.example:443',sections:['Disabled VPN']}]};
  class Base{}
  Base.extend=props=>{class Module{} Object.assign(Module.prototype,props);return Module;};
  const ctx=vm.createContext({baseclass:Base,_:s=>s,
    L:{bind:(fn,self,...args)=>fn.bind(self,...args),hasViewPermission:()=>state.writable},
    E:(tag,attrs,children)=>({tag,attrs,children,style:{},textContent:typeof children==='string'?children:'',replaceChildren(...items){this.children=items;}}),
    rpc:{declare:spec=>async(id)=>{
      if(spec.method==='connections')return {connections:state.entries};
      state.calls.push(id);
      if(state.pending)return state.pending;
      return id==='b'?{code:1,message:'Handshake failed'}:{code:0,ip:'203.0.113.10',latency_ms:98};
    }}
  });
  vm.runInContext("String.prototype.format=function(...args){let i=0;return this.replace(/%s/g,()=>String(args[i++]));};",ctx);
  const Factory=vm.runInContext('(function(){'+readFileSync(resolve(__dirname,'../package/luci-app-krotex/htdocs/luci-static/resources/krotex/connections.js'),'utf8')+'\n})()',ctx);
  const checker=new Factory().create({onBusy:busy=>{state.busy.push(busy);checker.setState(busy,true);}});
  checker.render();checker.setState(false,true);state.checker=checker;return state;
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('overview checker checks each listed profile once and retains individual success and errors',async()=>{
  const state=harness(),checker=state.checker;await checker.load();await checker.checkAll();
  assert.deepEqual(state.calls,['a','b']);assert.deepEqual(state.busy,[true,false]);
  assert.match(checker.outputs.a.textContent,/203.0.113.10/);assert.match(checker.outputs.a.textContent,/98 ms/);
  assert.equal(checker.outputs.a.style.color,'#22863a');
  assert.equal(checker.outputs.b.textContent,'Handshake failed');assert.equal(checker.outputs.b.style.color,'#d93025');
  assert.equal(checker.testing,false);assert.equal(checker.button.disabled,false);
});

test('automatic checks wait for Overview and do not repeat with status polling or tab switching',async()=>{
  const state=harness(),checker=state.checker;await checker.load();assert.equal(state.calls.length,0);
  checker.setVisible(true);await tick();assert.deepEqual(state.calls,['a','b']);
  checker.setState(false,true);checker.setVisible(false);checker.setVisible(true);await tick();
  assert.equal(state.calls.length,2);
});

test('Stop checking finishes the current request and skips the rest',async()=>{
  const state=harness(),checker=state.checker;await checker.load();
  let finish;state.pending=new Promise(resolve=>{finish=resolve;});
  const task=checker.checkAll();await tick();assert.deepEqual(state.calls,['a']);
  await checker.checkAll();assert.equal(checker.button.disabled,true);
  finish({code:0,ip:'203.0.113.10',latency_ms:0});await task;
  assert.deepEqual(state.calls,['a']);assert.equal(checker.testing,false);assert.equal(checker.button.disabled,false);
  assert.match(checker.outputs.a.textContent,/0 ms/);assert.equal(checker.summary.textContent,'Check stopped.');
});

test('read-only and unavailable states never start probes',async()=>{
  const state=harness(false),checker=state.checker;await checker.load();checker.setVisible(true);await checker.checkAll();
  assert.equal(checker.button.disabled,true);assert.equal(state.calls.length,0);
  state.writable=true;checker.setState(false,false);await checker.checkAll();assert.equal(state.calls.length,0);
});

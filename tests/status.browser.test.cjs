// Linux browser check for textbox sizing and the actual DOM event handlers.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

test('saved VLESS link is fully visible and two devices can be added and removed in Chromium', () => {
  const work = mkdtempSync(join(tmpdir(), 'krotex-browser-'));
  try {
    const view = readFileSync(resolve(__dirname, '../package/luci-app-krotex/htdocs/luci-static/resources/view/krotex/status.js'), 'utf8');
    const vless = readFileSync(resolve(__dirname, '../package/luci-app-krotex/htdocs/luci-static/resources/krotex/vless.js'), 'utf8');
    const html = `<!doctype html><meta charset="utf-8"><style>body{width:420px;font:16px sans-serif}textarea{font:14px monospace}</style><script>
      const _ = value => value;
      String.prototype.format = function(...args) { let i=0; return this.replace(/%s|%\\.1f/g, () => String(args[i++])); };
      const E = (tag, attrs, children) => {
        const element = document.createElement(tag);
        for (const [key,value] of Object.entries(attrs || {})) {
          if (typeof value === 'function') element.addEventListener(key, value);
          else if (key === 'disabled') element.disabled = value;
          else element.setAttribute(key,value);
        }
        if (children != null) element.append(...(Array.isArray(children) ? children : [children]));
        return element;
      };
      const L = { bind:(fn,self,...args)=>fn.bind(self,...args), hasViewPermission:()=>true };
      const ui = { createHandlerFn:(self,name,arg)=>()=>self[name](arg), addNotification:()=>{} };
      const poll = { add:()=>{} };
      const baseclass = { extend: props => function() { Object.assign(this,props); } };
      const vless = new ((function(){${vless}\n})())();
      const link = 'vless://11111111-2222-4333-8444-555555555555@proxy.example:443?security=tls&sni=example.com&fm=' + 'a'.repeat(1800) + '#Saved%20name';
      const mac1 = '02:11:22:33:44:55', mac2 = '02:aa:bb:cc:dd:ee';
      let macs = [];
      const rpc = { declare:spec=>async(mac,enabled)=> {
        if(spec.method==='status') return {available:true,installed:true,running:true};
        if(spec.method==='connection') return {configured:true,link,address:'proxy.example',port:443,security:'tls'};
        if(spec.method==='devices') return {devices:[{mac:mac1,name:'Laptop',address:'192.168.1.10'}]};
        if(spec.method==='routing') return {macs:macs.slice(),enabled:!!macs.length,active:!!macs.length};
        if(spec.method==='set_routing') { macs=macs.filter(item=>item!==mac); if(enabled)macs.push(mac); return {code:0}; }
        return {code:0};
      }};
      const view = { extend: value=>value };
      const page = (function(){${view}\n})();
      const pause = () => new Promise(resolve=>setTimeout(resolve,50));
      const check = (condition,message) => { if(!condition)throw new Error(message); };
      addEventListener('DOMContentLoaded',async()=> {
        try {
          document.body.append(page.render(await page.load()));
          await pause();
          check(page.connectionInput.value===link,'saved link is incomplete');
          check(page.connectionInput.scrollHeight<=page.connectionInput.clientHeight+2,'textbox clips saved link: scroll='+page.connectionInput.scrollHeight+' client='+page.connectionInput.clientHeight);
          check(page.connectionInput.clientHeight>500,'long link was not expanded');
          page.deviceSelect.value=mac1;
          page.deviceSelect.dispatchEvent(new Event('change'));
          await pause();
          page.routingMac.value=mac2;
          await page.handleRouting(true);
          check(page.routingList.children.length===2 && macs.length===2,'second device replaced first');
          page.routingRemoveButtons[0].click();
          await pause();
          check(macs.length===1 && macs[0]===mac2,'cross removed wrong device');
          check(page.routingList.children.length===1,'removed device remains visible');
          document.body.dataset.testResult='pass';
        } catch(error) { document.body.dataset.testResult='fail'; document.body.append(error.stack); }
      });
    </script><body></body>`;
    const path = join(work, 'view.html');
    writeFileSync(path, html);
    const output = execFileSync(process.env.CHROMIUM_BIN || 'chromium-headless-shell', [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
      '--user-data-dir=' + join(work, 'profile'), '--virtual-time-budget=3000', '--dump-dom', pathToFileURL(path).href
    ], { encoding:'utf8', timeout:20000, stdio:['ignore','pipe','pipe'] });
    assert.equal(/data-test-result="pass"/.test(output), true, output.slice(-2500));
  } finally {
    rmSync(work, { recursive:true, force:true });
  }
});

// Linux browser check for textbox sizing and the actual DOM event handlers.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

test('sections, full VLESS links and multiple devices work in Chromium', () => {
  const work = mkdtempSync(join(tmpdir(), 'krotex-browser-'));
  try {
    const view = readFileSync(resolve(__dirname, '../package/luci-app-krotex/htdocs/luci-static/resources/view/krotex/status.js'), 'utf8');
    const vless = readFileSync(resolve(__dirname, '../package/luci-app-krotex/htdocs/luci-static/resources/krotex/vless.js'), 'utf8');
    const sections = readFileSync(resolve(__dirname, '../package/luci-app-krotex/htdocs/luci-static/resources/krotex/sections.js'), 'utf8');
    const html = `<!doctype html><meta charset="utf-8"><style>body{width:420px;font:16px sans-serif}textarea{font:14px monospace}</style><script>
      const _ = value => value;
      String.prototype.format = function(...args) { let i=0; return this.replace(/%s|%\\.1f/g, () => String(args[i++])); };
      const E = (tag, attrs, children) => {
        const element = document.createElement(tag);
        for (const [key,value] of Object.entries(attrs || {})) {
          if (typeof value === 'function') element.addEventListener(key, value);
          // LuCI dom.attr() stringifies booleans as attributes too. In
          // particular selected="false" still selects an HTML option.
          else if (value != null) element.setAttribute(key, typeof value === 'object' ? JSON.stringify(value) : value);
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
      let saved = [{id:'vpn1',name:'VPN 1',mode:'proxy',enabled:true,fallback:true,domains:[],profile:{url:link}}];
      const rpc = { declare:spec=>async(mac,enabled)=> {
        if(spec.method==='status') return {available:true,installed:true,running:true};
        if(spec.method==='sections') return {sections:saved};
        if(spec.method==='save_sections') { saved=JSON.parse(mac);return {code:0}; }
        if(spec.method==='devices') return {devices:[{mac:mac1,name:'Laptop',address:'192.168.1.10'}]};
        if(spec.method==='routing') return {macs:macs.slice(),enabled:!!macs.length,active:!!macs.length};
        if(spec.method==='set_routing') { macs=macs.filter(item=>item!==mac); if(enabled)macs.push(mac); return {code:0}; }
        return {code:0};
      }};
      const sections = new ((function(){${sections}\n})())();
      const view = { extend: value=>value };
      const page = (function(){${view}\n})();
      const pause = () => new Promise(resolve=>setTimeout(resolve,50));
      const check = (condition,message) => { if(!condition)throw new Error(message); };
      addEventListener('DOMContentLoaded',async()=> {
        try {
          document.body.append(page.render(await page.load()));
          await pause();
          const input=document.querySelector('textarea[aria-label="VLESS link"]');
          check(input.value===link,'saved link is incomplete');
          check(input.scrollHeight<=input.clientHeight+2,'textbox clips saved link');
          check(input.clientHeight>500,'long link was not expanded');
          const editor=page.sectionsEditor;
          const card=(index)=>editor.cards.children[index];
          const route=(index)=>card(index).querySelector('select[aria-label="Section route"]');
          const choose=(index,value)=>{route(index).value=value;route(index).dispatchEvent(new Event('change'));};
          check(route(0).value==='proxy','saved proxy is displayed with the wrong type');
          choose(0,'direct');
          check(route(0).value==='direct'&&!card(0).querySelector('textarea[aria-label="VLESS link"]'),'type and VLESS field disagree');
          choose(0,'proxy');
          check(route(0).value==='proxy'&&card(0).querySelector('textarea[aria-label="VLESS link"]').value===link,'cannot switch back to Xray');
          check(editor.topControls.length===2,'there must be one add button and one save button');
          editor.topControls[0].click();
          check(route(1).value==='unconfigured'&&!editor.sections[1].enabled,'new section has a configured route');
          check(card(1).querySelector('input[aria-label="Enable section"]').disabled,'unconfigured section can be enabled');
          await editor.save();
          check(route(1).value==='unconfigured','unconfigured section did not survive reopening');
          choose(1,'direct');editor.sections[1].name='exclude';editor.sections[1].domains='example.com';editor.move(1,-1);
          check(editor.cards.children[0].querySelector('select[aria-label="Section route"]').value==='direct','Direct section is displayed as Xray');
          editor.add();choose(2,'proxy');editor.sections[2].url=link;editor.sections[2].name='VPN 2';editor.renderCards();
          check(!editor.cards.querySelector('strong'),'duplicate section heading remains');
          const nameInput=card(2).querySelector('input[aria-label="Section name"]');
          const remove=card(2).querySelector('button[aria-label="Remove section"]');
          check(nameInput.parentElement===remove.parentElement,'name and action buttons are on different rows');
          check(Math.abs(nameInput.getBoundingClientRect().y-remove.getBoundingClientRect().y)<12,'name and buttons do not line up');
          const fallback=editor.cards.children[2].querySelector('input[aria-label="Use for unmatched traffic"]');
          fallback.checked=true;fallback.dispatchEvent(new Event('change'));
          await editor.save();
          check(saved.length===3&&saved[0].name==='exclude'&&saved[2].name==='VPN 2','section order was lost');
          check(saved[2].fallback&&!saved[1].fallback,'default section selection was lost');
          check(saved[2].profile.url===link,'section link was not retained');
          check(card(0).querySelector('input[aria-label="Use for unmatched traffic"]').checked===false,'false checkbox attribute enabled the direct default');
          check(card(2).querySelector('input[aria-label="Use for unmatched traffic"]').checked===true,'default checkbox does not match the model');
          document.body.style.width='1000px';
          check(page.statsPanel.getBoundingClientRect().height<100,'desktop statistics are too tall');
          check(page.statsPanel.querySelectorAll('dt').length===7,'statistics lost a metric');
          document.body.style.width='320px';
          check(page.statsPanel.scrollWidth<=page.statsPanel.clientWidth+2,'statistics overflow on mobile');
          check(page.statsPanel.getBoundingClientRect().height<240,'mobile statistics are too tall');
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

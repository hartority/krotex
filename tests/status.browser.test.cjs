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
    const html = `<!doctype html><meta charset="utf-8"><style>body{width:420px;font:16px sans-serif}textarea{font:14px monospace}
      /* LuCI Bootstrap draws its own checkbox using pseudo-elements. */
      input[type=checkbox]::before,input[type=checkbox]::after{position:absolute;content:""}
      input[type=checkbox]::before{top:0;left:0;width:14px;height:14px;background:#555;border:1px solid #888}
      input[type=checkbox]:checked::after{top:2px;left:2px;width:10px;height:10px;background:#ddd}
      </style><script>
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
      let routingMode='selected';
      let checkFailure = false;
      let saved = [{id:'vpn1',name:'VPN 1',mode:'proxy',enabled:true,fallback:true,domains:[],profile:{url:link}}];
      const rpc = { declare:spec=>async(mac,enabled)=> {
        if(spec.method==='status') return {available:true,installed:true,running:true};
        if(spec.method==='sections') return {sections:saved};
        if(spec.method==='save_sections') { saved=JSON.parse(mac);return {code:0}; }
        if(spec.method==='test_section') return checkFailure ? {code:1,message:'Proxy connection failed'} : {code:0,ip:'203.0.113.10'};
        if(spec.method==='devices') return {devices:[{mac:mac1,name:'Laptop',address:'192.168.1.10'}]};
        if(spec.method==='routing') return {mode:routingMode,macs:macs.slice(),enabled:routingMode==='all'||!!macs.length,active:routingMode==='all'||!!macs.length};
        if(spec.method==='set_routing_mode') {routingMode=mac;return {code:0};}
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
          const endpoint=document.querySelector('[aria-label="Configured VLESS server"]');
          const change=document.querySelector('button[aria-label="Change VLESS connection"]');
          check(endpoint.textContent==='proxy.example:443','saved server summary is missing');
          check(!document.querySelector('textarea[aria-label="VLESS link"]'),'saved connection is not collapsed');
          check(endpoint.parentElement===change.parentElement,'Change is not beside the saved endpoint');
          check(endpoint.parentElement.getBoundingClientRect().height<70,'saved connection is not compact');
          change.click();await pause();
          const input=document.querySelector('textarea[aria-label="VLESS link"]');
          check(input.value===link,'saved link is incomplete');
          check(input.scrollHeight<=input.clientHeight+2,'textbox clips saved link');
          check(input.clientHeight>500,'long link was not expanded');
          const cancel=document.querySelector('[aria-label="Cancel VLESS editing"]');
          check(cancel,'VLESS editing has no Cancel button');
          check(cancel.textContent==='×','Cancel is not a compact cross');
          const textboxBounds=input.getBoundingClientRect(),cancelBounds=cancel.getBoundingClientRect();
          check(cancelBounds.top>=textboxBounds.top&&cancelBounds.top<textboxBounds.top+12&&cancelBounds.right<=textboxBounds.right&&cancelBounds.right>textboxBounds.right-12,'Cancel is not inside the top-right of the textbox');
          check(getComputedStyle(cancel).color==='rgb(217, 48, 37)','Cancel cross is not red');
          input.value='invalid';input.dispatchEvent(new Event('input'));
          cancel.click();
          const editor=page.sectionsEditor;
          check(!editor.dirty&&!document.querySelector('textarea[aria-label="VLESS link"]'),'Cancel did not restore and collapse the saved link');
          check(editor.sections[0].url===link,'Cancel retained the edited link');
          document.querySelector('[aria-label="Change VLESS connection"]').click();
          const card=(index)=>editor.cards.children[index];
          const route=(index)=>card(index).querySelector('select[aria-label="Section route"]');
          const choose=(index,value)=>{route(index).value=value;route(index).dispatchEvent(new Event('change'));};
          check(route(0).value==='proxy','saved proxy is displayed with the wrong type');
          choose(0,'direct');
          check(route(0).value==='direct'&&!card(0).querySelector('textarea[aria-label="VLESS link"]'),'type and VLESS field disagree');
          choose(0,'proxy');
          check(route(0).value==='proxy'&&card(0).querySelector('textarea[aria-label="VLESS link"]').value===link,'cannot switch back to Xray');
          check(editor.topControls.length===4,'section controls must include one default route selector');
          check(editor.fallbackSelect.value==='vpn1','saved default VPN was not restored');
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
          const enabled=card(2).querySelector('input[aria-label="Enable section"]');
          check(nameInput.parentElement===remove.parentElement,'name and action buttons are on different rows');
          check(enabled.parentElement.parentElement===nameInput.parentElement,'Enabled is not in the section header');
          check(enabled.getAttribute('role')==='switch','Enabled is not a switch');
          check(getComputedStyle(enabled,'::before').content==='""','theme checkbox reproduction is missing');
          check(getComputedStyle(enabled).opacity==='0','theme checkbox remains visible over the switch');
          enabled.focus();
          check(getComputedStyle(enabled.nextElementSibling).outlineStyle==='solid','switch lacks a visible keyboard focus indicator');
          enabled.blur();
          const up=card(2).querySelector('button[aria-label="Move section up"]');
          check(Math.abs(enabled.parentElement.getBoundingClientRect().height-up.getBoundingClientRect().height)<=2,'switch height does not match the buttons');
          check(nameInput.getBoundingClientRect().right<=enabled.getBoundingClientRect().left&&enabled.getBoundingClientRect().right<=up.getBoundingClientRect().left,'Enabled is not between the name and arrows');
          check(Math.abs(nameInput.getBoundingClientRect().y-remove.getBoundingClientRect().y)<12,'name and buttons do not line up');
          enabled.click();
          check(!editor.sections[2].enabled&&!card(2).querySelector('[role="switch"]').checked,'switch does not disable the section');
          card(2).querySelector('[role="switch"]').click();
          check(editor.sections[2].enabled,'switch does not re-enable the section');
          editor.fallbackSelect.value=editor.sections[2].id;editor.fallbackSelect.dispatchEvent(new Event('change'));
          await editor.save();
          check(saved.length===3&&saved[0].name==='exclude'&&saved[2].name==='VPN 2','section order was lost');
          check(saved[2].fallback&&!saved[1].fallback,'default section selection was lost');
          check(saved[2].profile.url===link,'section link was not retained');
          check(!editor.cards.querySelector('textarea[aria-label="VLESS link"]'),'successful save did not collapse connections');
          check(card(2).querySelector('[aria-label="Configured VLESS server"]').textContent==='proxy.example:443','newly saved connection summary is wrong');
          check(editor.saveButton.parentElement===editor.resetButton.parentElement,'Reset is not next to Save');
          const green=getComputedStyle(editor.saveButton).backgroundColor;
          check(green==='rgb(33, 135, 57)','save button is not green');
          const checkButton=Array.from(card(1).querySelectorAll('button')).find(b=>b.textContent==='Check connection');
          const output=card(1).querySelector('[aria-label="Connection check result"]');
          check(checkButton.parentElement===output.parentElement,'connection result is not next to its button');
          checkFailure=true;
          checkButton.click();await pause();
          check(output.textContent==='Proxy connection failed','error is missing from its section');
          check(getComputedStyle(output).color==='rgb(217, 48, 37)','connection error is not red');
          check(!editor.result.textContent.includes('Proxy connection failed'),'connection error appeared below all sections');
          const domainsLabel=Array.from(card(1).querySelectorAll('label')).find(l=>l.textContent.startsWith('Domains'));
          check(checkButton.parentElement===card(1).lastElementChild,'section actions are not the final row');
          check(checkButton.parentElement.getBoundingClientRect().y>domainsLabel.getBoundingClientRect().bottom,'section actions appear above the domain settings');
          checkFailure=false;
          checkButton.click();await pause();
          check(output.textContent.includes('203.0.113.10'),'successful check did not replace the error');
          editor.add();check(editor.sections.length===4,'draft section was not added');
          editor.resetButton.click();await pause();
          check(editor.sections.length===3&&!editor.dirty,'Reset did not restore saved sections');
          check(!editor.cards.querySelector('input[aria-label="Use for unmatched traffic"]'),'per-section default checkbox remains');
          check(editor.fallbackSelect.value===saved[2].id,'saved default VPN is not selected in the shared list');
          check(editor.fallbackSelect.parentElement.parentElement===editor.topControls[0].parentElement,'default selector is not beside Add section');
          document.body.style.width='1000px';
          const heading=page.pageHeader.querySelector('h2').getBoundingClientRect();
          const actions=page.serviceActions.getBoundingClientRect();
          check(actions.left>heading.right&&Math.abs(actions.y-heading.y)<30,'service controls are not beside the heading');
          check(page.pageHeader.getBoundingClientRect().bottom<=page.statsPanel.getBoundingClientRect().top,'service controls remain under the statistics');
          check(page.statsPanel.getBoundingClientRect().height<100,'desktop statistics are too tall');
          check(page.statsPanel.querySelectorAll('dt').length===7,'statistics lost a metric');
          document.body.style.width='320px';
          check(page.statsPanel.scrollWidth<=page.statsPanel.clientWidth+2,'statistics overflow on mobile');
          check(page.statsPanel.getBoundingClientRect().height<240,'mobile statistics are too tall');
          check(page.pageHeader.scrollWidth<=page.pageHeader.clientWidth+2,'service controls overflow on mobile');
          page.deviceSelect.value=mac1;
          page.deviceSelect.dispatchEvent(new Event('change'));
          await pause();
          page.routingMac.value=mac2;
          await page.handleRouting(true);
          check(page.routingList.children.length===2 && macs.length===2,'second device replaced first');
          const deviceName=page.routingList.querySelector('strong');
          check(deviceName.textContent==='Laptop','device card lacks a readable name');
          check(page.routingList.textContent.includes('192.168.1.10')&&page.routingList.textContent.includes(mac1),'device card lost addresses');
          document.body.style.color='#ddd';document.body.style.background='#222';
          check(getComputedStyle(deviceName).color==='rgb(221, 221, 221)','device name is grey in dark mode');
          document.body.style.color='#222';document.body.style.background='#fff';
          check(getComputedStyle(deviceName).color==='rgb(34, 34, 34)','device name is unreadable in light mode');
          page.routingMode.value='all';page.routingMode.dispatchEvent(new Event('change'));await pause();
          check(routingMode==='all'&&getComputedStyle(page.deviceSelection).display==='none','all mode did not hide device selection');
          check(getComputedStyle(page.allDevicesNotice).display!=='none','all mode lacks a description');
          check(getComputedStyle(page.allDevicesNotice).borderLeftWidth===getComputedStyle(page.allDevicesNotice).borderRightWidth,'notice still has a thick left border');
          check(page.routingSummary.getBoundingClientRect().top-page.routingMode.getBoundingClientRect().bottom>=10,'routing status touches the mode selector');
          page.routingMode.value='selected';page.routingMode.dispatchEvent(new Event('change'));await pause();
          check(macs.length===2&&page.routingList.children.length===2,'switching modes lost the saved device list');
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

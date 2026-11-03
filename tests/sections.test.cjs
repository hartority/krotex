const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { test } = require('node:test');

const runtime = process.env.OPENWRT_TEST_ROOT;
const compiler = resolve(__dirname, '../package/krotex/files/sections.uc');
const profile = { id:'11111111-2222-4333-8444-555555555555', address:'proxy.example', port:443,
  security:'tls', server_name:'example.com', fingerprint:'chrome', public_key:'', short_id:'', spider_x:'/', flow:'', alpn:'' };
function section(id, mode, domains=[], fallback=false) {
  return { id, name:id, mode, domains, fallback, enabled:true, ...(mode==='proxy' ? {profile:{...profile}} : {}) };
}
function run(operation, sections, config={outbounds:[]}) {
  const work = mkdtempSync(join(tmpdir(),'krotex-sections-'));
  try {
    writeFileSync(join(work,'config.json'),JSON.stringify(config));
    writeFileSync(join(work,'request.json'),JSON.stringify({sections:JSON.stringify(sections)}));
    const result = spawnSync(join(runtime,'lib/ld-musl-x86_64.so.1'), ['--library-path',runtime+'/lib:'+runtime+'/usr/lib',
      runtime+'/usr/bin/ucode','-L',runtime+'/usr/lib/ucode',compiler,operation,join(work,'config.json'),join(work,'request.json')], {encoding:'utf8'});
    if (result.status !== 0) throw new Error(result.stderr);
    return operation==='firewall' ? result.stdout : JSON.parse(result.stdout);
  } finally { rmSync(work,{recursive:true,force:true}); }
}

test('section compiler: domain priority, default VPN, direct fallback and native Xray validation', {skip:!runtime}, () => {
  const config = run('compile', [section('exclude','direct',['Example.COM','*.example.com']),
    section('vpn2','proxy',[],true), section('vpn1','proxy',['youtube.com','overlap.example.com'])]);
  const rules = config.routing.rules.filter(rule=>rule.inboundTag.includes('device-tproxy'));
  assert.deepEqual(rules.map(rule=>rule.outboundTag),['direct','section-vpn1','section-vpn2']);
  assert.deepEqual(rules[0].domain,['domain:example.com']);
  assert.equal(config.krotex_sections[1].fallback,true);
  assert.equal(run('read',[],config).legacy,false);
  assert.equal(config.outbounds.find(o=>o.tag==='section-vpn1').protocol,'vless');
  assert.equal(config.inbounds.find(i=>i.tag==='section-check-vpn1').port,11082);
  const direct = run('compile',[section('vpn1','proxy',['youtube.com'])]);
  assert.equal(direct.routing.rules.at(-1).outboundTag,'direct');
  const empty = run('compile',[]);
  assert.equal(empty.routing.rules.at(-1).outboundTag,'direct');
  assert.equal(empty.outbounds[0].protocol,'freedom');
  if (process.env.XRAY_TEST_BINARY) {
    const work=mkdtempSync(join(tmpdir(),'krotex-sections-core-'));
    try {
      const path=join(work,'config.json'); writeFileSync(path,JSON.stringify(config));
      const fragment=resolve(__dirname,'../package/krotex/files/transparent.json');
      execFileSync(process.env.XRAY_TEST_BINARY,['run','-test','-config',fragment,'-config',path],{stdio:'pipe'});
      const output=execFileSync(process.env.XRAY_TEST_BINARY,['run','-dump','-config',fragment,'-config',path],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
      const merged=JSON.parse(output.slice(output.indexOf('{')));
      assert.deepEqual(merged.routing.rules,config.routing.rules,'the runtime merge must retain section priority and DNS rules');
    } finally { rmSync(work,{recursive:true,force:true}); }
  }
});

test('section compiler: preserves legacy VLESS connection as the default section', {skip:!runtime}, () => {
  const compiled=run('compile',[section('vpn1','proxy')]);
  const legacy={outbounds:[{...compiled.outbounds.find(o=>o.tag==='section-vpn1'),tag:'proxy'}],krotex_link:'vless://original#name'};
  const result=run('read',[],legacy);
  assert.equal(result.legacy,true);
  assert.equal(result.sections.length,1);
  assert.equal(result.sections[0].fallback,true);
  assert.equal(result.sections[0].profile.url,'vless://original#name');
  assert.equal(result.sections[0].profile.id,profile.id);
});

test('section compiler: rejects ambiguous defaults, injected rules, malformed domains and profiles', {skip:!runtime}, () => {
  const invalid=[
    [section('a','direct',[],true),section('b','proxy',[],true)],
    [section('a','direct'),section('a','proxy')],
    [section('a','direct',['regexp:.*'])],
    [section('a','direct',['https://youtube.com/path'])],
    [section('a','direct',['example.com\nbad'])],
    [section('a','direct',['-bad.example'])],
    [{...section('a','proxy'),profile:{...profile,port:'443'}}],
    [{...section('a','proxy'),profile:{...profile,security:'none'}}],
    [{...section('a','direct',[],true),enabled:false}]
  ];
  for(const items of invalid) assert.throws(()=>run('compile',items));
  const config=run('compile',[{...section('a','direct',['youtube.com']),outboundTag:'evil',routing:{rules:[{}]}}]);
  assert.equal(config.routing.rules.find(r=>r.domain).outboundTag,'direct');
  assert.equal(config.krotex_sections[0].routing,undefined);
});

test('unconfigured sections persist without producing routes, outbounds or a default', {skip:!runtime}, () => {
  const draft={...section('draft','unconfigured',['example.com']),enabled:false};
  const config=run('compile',[draft,section('vpn1','proxy',['youtube.com'])]);
  assert.equal(config.krotex_sections[0].mode,'unconfigured');
  assert.equal(run('read',[],config).sections[0].enabled,false);
  assert.equal(config.routing.rules.some(r=>r.domain?.includes('domain:example.com')),false);
  assert.equal(config.outbounds.some(o=>o.tag==='section-draft'),false);
  assert.equal(config.routing.rules.at(-1).outboundTag,'direct');
  assert.throws(()=>run('compile',[{...draft,enabled:true}]));
  assert.throws(()=>run('compile',[{...draft,fallback:true}]));
});


test('Block uses blackhole while preserving priority, subdomains and optional unmatched blocking', {skip:!runtime}, () => {
  const config=run('compile',[section('exception','direct',['allowed.blocked.example']),
    section('deny','block',['Blocked.Example','*.blocked.example']),
    section('deny2','block',['another.example']),section('vpn','proxy',[],true)]);
  const rules=config.routing.rules.filter(rule=>rule.inboundTag.includes('device-tproxy'));
  assert.deepEqual(rules.map(rule=>rule.outboundTag),['direct','block','block','section-vpn']);
  assert.deepEqual(rules[1].domain,['domain:blocked.example']);
  assert.deepEqual(config.outbounds.filter(o=>o.protocol==='blackhole'),[
    {tag:'block',protocol:'blackhole',settings:{response:{type:'none'}}}
  ]);
  assert.equal(run('read',[],config).sections[1].mode,'block');
  assert.equal(config.inbounds.some(i=>i.tag==='section-check-deny'),false);
  const disabled=run('compile',[{...section('deny','block',['blocked.example']),enabled:false}]);
  assert.equal(disabled.outbounds.some(o=>o.protocol==='blackhole'),false);
  assert.equal(disabled.routing.rules.some(r=>r.domain),false);
  const fallback=run('compile',[section('allow','direct',['allowed.example']),section('deny','block',[],true)]);
  assert.equal(fallback.routing.rules.at(-1).outboundTag,'block');
  assert.equal(fallback.outbounds.find(o=>o.tag==='proxy').protocol,'freedom','DNS must remain usable when unmatched traffic is blocked');
  if(process.env.XRAY_TEST_BINARY) {
    const work=mkdtempSync(join(tmpdir(),'krotex-block-'));
    try {
      const path=join(work,'config.json');writeFileSync(path,JSON.stringify(config));
      execFileSync(process.env.XRAY_TEST_BINARY,['run','-test','-config',resolve(__dirname,'../package/krotex/files/transparent.json'),'-config',path],{stdio:'pipe'});
    } finally {rmSync(work,{recursive:true,force:true});}
  }
});


test('comments persist as editor text and never become Xray domain rules', {skip:!runtime}, () => {
  const source='#ip-api.com\n\n  # disabled domain\nExample.com\n  *.Example.com  \n';
  const config=run('compile',[{...section('deny','block',['ignored.example']),domains_text:source}]);
  assert.equal(config.krotex_sections[0].domains_text,source);
  assert.deepEqual(config.krotex_sections[0].domains,['example.com']);
  assert.deepEqual(config.routing.rules.find(r=>r.domain).domain,['domain:example.com']);
  const reopened=run('read',[],config).sections[0];
  assert.equal(reopened.domains_text,source);
  const savedAgain=run('compile',[reopened]);
  assert.equal(savedAgain.krotex_sections[0].domains_text,source);
  const commentsOnly=run('compile',[{...section('deny','block'),domains_text:'#ip-api.com\n'}]);
  assert.deepEqual(commentsOnly.krotex_sections[0].domains,[]);
  assert.equal(commentsOnly.routing.rules.some(r=>r.domain),false);
  assert.throws(()=>run('compile',[{...section('deny','block'),domains_text:'#comment\nhttps://bad.example/path'}]));
  assert.throws(()=>run('compile',[{...section('deny','block'),domains_text:123}]));
});


test('device VPNs have isolated transparent and DNS routes independent of common rules', {skip:!runtime}, () => {
  const mac='02:11:22:33:44:55';
  const device={...section('tv','proxy_devices'),macs:[mac],profile:{...profile}};
  const config=run('compile',[section('deny','block',['example.com'],true),device]);
  assert.equal(config.krotex_sections[1].macs[0],mac);
  const inbound=config.inbounds.find(i=>i.tag==='device-section-tv');
  assert.equal(inbound.port,12081);assert.equal(inbound.settings.network,'tcp,udp');
  assert.equal(inbound.streamSettings.sockopt.tproxy,'tproxy');
  assert.equal(config.routing.rules.find(r=>r.inboundTag.includes('device-section-tv')).outboundTag,'section-tv');
  assert.equal(config.outbounds.find(o=>o.tag==='device-section-tv-dns').streamSettings.sockopt.dialerProxy,'section-tv');
  assert.equal(config.outbounds.find(o=>o.tag==='proxy').protocol,'freedom','a private device VPN must not become the general DNS VPN');
  assert.deepEqual(run('devices',[],config),{routes:[{macs:[mac],port:12081,dns_port:12113}]});
  assert.equal(run('read',[],config).sections[1].mode,'proxy_devices');
  assert.throws(()=>run('compile',[{...device,fallback:true}]));
  assert.throws(()=>run('compile',[{...device,macs:[]}]));
  assert.throws(()=>run('compile',[device,{...device,id:'other'}]));
  assert.throws(()=>run('compile',[{...device,macs:['01:11:22:33:44:55']}]));
  const disabled=run('compile',[{...device,enabled:false}]);
  assert.deepEqual(run('devices',[],disabled),{routes:[]});
  assert.equal(disabled.inbounds.some(i=>i.tag==='device-section-tv'),false);
  if(process.env.XRAY_TEST_BINARY) {
    const work=mkdtempSync(join(tmpdir(),'krotex-device-'));
    try {
      const path=join(work,'config.json');writeFileSync(path,JSON.stringify(config));
      execFileSync(process.env.XRAY_TEST_BINARY,['run','-test','-config',resolve(__dirname,'../package/krotex/files/transparent.json'),'-config',path],{stdio:'pipe'});
    } finally {rmSync(work,{recursive:true,force:true});}
  }
});


test('overview deduplicates runtime profiles and probes inactive saved connections in isolation', {skip:!runtime}, () => {
  const first={...section('a','proxy'),profile:{...profile,url:'vless://one#A'}};
  const duplicate={...section('b','proxy_devices'),enabled:false,macs:['02:11:22:33:44:55'],profile:{...profile,url:'vless://two#B'}};
  const other={...section('c','proxy'),enabled:false,profile:{...profile,id:'22222222-2222-4333-8444-555555555555'}};
  const config=run('compile',[first,duplicate,other]);
  const list=run('connections',[],config).connections;
  assert.equal(list.length,2);
  assert.deepEqual(list[0].sections,['a','b']);assert.equal(list[0].endpoint,'proxy.example:443');
  const work=mkdtempSync(join(tmpdir(),'krotex-probe-'));
  try {
    writeFileSync(join(work,'config.json'),JSON.stringify(config));
    writeFileSync(join(work,'request.json'),JSON.stringify({id:'b'}));
    const output=execFileSync(join(runtime,'lib/ld-musl-x86_64.so.1'),['--library-path',runtime+'/lib:'+runtime+'/usr/lib',
      runtime+'/usr/bin/ucode','-L',runtime+'/usr/lib/ucode',compiler,'probe',join(work,'config.json'),join(work,'request.json')],{encoding:'utf8'});
    const probe=JSON.parse(output);
    assert.equal(probe.inbounds[0].port,11180);assert.equal(probe.inbounds[0].listen,'127.0.0.1');
    assert.equal(probe.outbounds[0].settings.vnext[0].users[0].id,profile.id);
    assert.equal(probe.krotex_sections,undefined);
    if(process.env.XRAY_TEST_BINARY) {
      writeFileSync(join(work,'probe.json'),output);
      execFileSync(process.env.XRAY_TEST_BINARY,['run','-test','-config',join(work,'probe.json')],{stdio:'pipe'});
    }
  } finally {rmSync(work,{recursive:true,force:true});}
});


test('mixed domain, IPv4 and CIDR destinations are OR rules with section priority preserved', {skip:!runtime}, () => {
  const source='# paused\nexample.com\n1.2.3.4\n8.8.8.123/24\n8.8.8.0/24\n';
  const config=run('compile',[{...section('vpn','proxy'),domains_text:source},section('deny','block',['8.8.0.0/16']),section('direct','direct',['9.9.9.9'])]);
  const rules=config.routing.rules.filter(r=>r.inboundTag.includes('device-tproxy'));
  assert.deepEqual(rules.map(r=>r.outboundTag),['section-vpn','section-vpn','block','direct','direct']);
  assert.deepEqual(rules[0].domain,['domain:example.com']);assert.equal(rules[0].ip,undefined);
  assert.deepEqual(rules[1].ip,['1.2.3.4','8.8.8.0/24']);assert.equal(rules[1].domain,undefined);
  assert.equal(config.krotex_sections[0].domains_text,source);
  assert.deepEqual(config.krotex_sections[0].ips,['1.2.3.4','8.8.8.0/24']);
  const normalized={...config.krotex_sections[0]};delete normalized.domains_text;
  assert.deepEqual(run('compile',[normalized]).krotex_sections[0].ips,normalized.ips,'recompiling saved metadata must retain its IPs');
  assert.deepEqual(run('compile',[section('all','direct',['1.2.3.4/0','1.2.3.4/32'])]).krotex_sections[0].ips,['0.0.0.0/0','1.2.3.4/32']);
  for(const value of ['256.2.3.4','1.2.3','1.2.3.4/33','1.2.3.4/-1','1.2.3.4/abc','1.2.3.4/24/5','example.com/24','2001:db8::1'])
    assert.throws(()=>run('compile',[section('bad','direct',[value])]));
  if(process.env.XRAY_TEST_BINARY) {
    const work=mkdtempSync(join(tmpdir(),'krotex-ip-rules-'));
    try {
      const path=join(work,'config.json');writeFileSync(path,JSON.stringify(config));
      execFileSync(process.env.XRAY_TEST_BINARY,['run','-test','-config',resolve(__dirname,'../package/krotex/files/transparent.json'),'-config',path],{stdio:'pipe'});
    } finally {rmSync(work,{recursive:true,force:true});}
  }
});


test('firewall policies enforce IP actions for every protocol and preserve earlier domain rules', {skip:!runtime}, () => {
  const config=run('compile',[section('direct','direct',['8.8.8.8']),section('deny','block',['8.8.0.0/16']),section('vpn','proxy',['9.9.9.0/24'],true)]);
  const policy=run('firewall',[],config);
  assert.ok(policy.indexOf('ip daddr { 8.8.8.8 } counter accept')<policy.indexOf('ip daddr { 8.8.0.0/16 } counter drop'));
  assert.match(policy,/ip daddr \{ 9\.9\.9\.0\/24 \} meta l4proto != \{ tcp, udp \} counter drop/);
  assert.match(policy,/meta l4proto != \{ tcp, udp \} counter drop\n$/);
  assert.match(policy,/udp dport 443 return/,'public QUIC remains subject to the capture chain block');
  const domainFirst=run('firewall',[],run('compile',[section('exception','direct',['allowed.example']),section('deny','block',['8.8.0.0/16'])]));
  assert.ok(domainFirst.indexOf('ip daddr { 8.8.0.0/16 } meta l4proto { tcp, udp } th dport != 53 return')<domainFirst.indexOf('ip daddr { 8.8.0.0/16 } counter drop'));
  assert.match(domainFirst,/counter accept\n$/,'unmatched non-TCP/UDP follows Direct');
  const disabled=run('firewall',[],run('compile',[{...section('deny','block',['8.8.0.0/16']),enabled:false}]));
  assert.equal(disabled.includes('ip daddr { 8.8.0.0/16 }'),false);
  const blockedDefault=run('firewall',[],run('compile',[section('deny','block',[],true)]));
  assert.match(blockedDefault,/counter drop\n$/);
});

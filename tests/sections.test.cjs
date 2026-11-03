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
    return JSON.parse(result.stdout);
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

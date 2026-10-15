'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const os=require('node:os');const path=require('node:path');const {EventEmitter}=require('node:events');
const {execFileSync,spawn}=require('node:child_process');
const {resolveCLIInvocation,findCLI,terminateProcessTree}=require('../lib/runtime.cjs');
const {describeAuth,createAuthInvocation,authEnvironment}=require('../lib/auth.cjs');
const {discoverApplications,discoveryFingerprint}=require('../lib/discovery.cjs');
const {isProtectedWorkspace}=require('../lib/domain.cjs');const {Telemetry}=require('../lib/telemetry.cjs');
const {Engine}=require('../lib/engine.cjs');
const {detectProviders}=require('../lib/providers.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-platform-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function npmCLI(t){const dir=fixture(t),pkg=path.join(dir,'node_modules/@openai/codex'),entry=path.join(pkg,'bin/codex.js'),shim=path.join(dir,'codex.cmd');
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',version:'1.0.0',bin:{codex:'bin/codex.js'}}));
  fs.writeFileSync(entry,"let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),input})));\n");
  fs.writeFileSync(shim,'@echo off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');fs.chmodSync(shim,0o700);return {dir,entry,shim};}
test('Windows npm CLI shims resolve to official Node entry points without shell expansion',t=>{
  const f=npmCLI(t),literal='$(touch canary) & echo private > canary',args=['--model','model & echo nope'];
  const invocation=resolveCLIInvocation({executable:f.shim,args,nodePath:process.execPath,platform:'win32'});
  assert.equal(invocation.shell,false);assert.equal(invocation.command,process.execPath);assert.deepEqual(invocation.args,[f.entry,...args]);
  const result=JSON.parse(execFileSync(invocation.command,invocation.args,{input:literal,encoding:'utf8',env:invocation.env,timeout:3000}));
  assert.deepEqual(result,{args,input:literal});assert.equal(fs.existsSync(path.join(f.dir,'canary')),false);
  assert.equal(findCLI('codex',{platform:'win32',home:f.dir,env:{PATH:f.dir,APPDATA:path.join(f.dir,'absent')}}),f.entry);
  fs.writeFileSync(f.shim,'@echo off\r\necho arbitrary command\r\n');assert.throws(()=>resolveCLIInvocation({executable:f.shim,platform:'win32'}),/官方 CLI/);
  const posix=path.join(f.dir,'dsh');fs.writeFileSync(posix,'#!/bin/sh\nexec node unknown.js\n',{mode:0o700});
  assert.throws(()=>resolveCLIInvocation({executable:posix,platform:'win32'}),/POSIX 脚本/);
  assert.equal(findCLI('dsh',{platform:'win32',home:f.dir,env:{PATH:f.dir}}),null);
});
test('Windows native CLI login and desktop launch keep fixed argv and required OS environment',()=>{
  for(const id of ['codex','claude']){
    const p={id,mode:'cli',executable:`C:\\Programs\\${id}.exe`};assert.equal(describeAuth(p,{platform:'win32'}).kind,'browser-cli');
    const x=createAuthInvocation(p,{platform:'win32'});assert.equal(x.command,p.executable);assert.equal(x.shell,false);
    assert.deepEqual(x.args,id==='codex'?['login']:['auth','login','--claudeai']);
  }
  const p={id:'doubao',mode:'handoff',installed:true,appPath:'C:\\Programs\\Doubao\\Doubao.exe'};
  assert.equal(describeAuth(p,{platform:'win32'}).kind,'desktop');assert.deepEqual(createAuthInvocation(p,{platform:'win32'}).args,[]);
  const env=authEnvironment('codex',{SystemRoot:'C:\\Windows',APPDATA:'C:\\Users\\test\\AppData\\Roaming',USERPROFILE:'C:\\Users\\test',OPENAI_API_KEY:'private',NODE_OPTIONS:'--require bad'});
  assert.equal(env.SystemRoot,'C:\\Windows');assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.NODE_OPTIONS,undefined);
});
test('Windows provider detection checks official npm entry login without relying on macOS application paths',t=>{
  const f=npmCLI(t);fs.writeFileSync(f.entry,"if(process.argv.includes('login'))console.log('Logged in using ChatGPT');\n");
  const connector=path.join(f.dir,'.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect');fs.mkdirSync(path.join(connector,'lib'),{recursive:true});
  fs.writeFileSync(path.join(connector,'package.json'),JSON.stringify({name:'dsh-workbuddy-connect',version:'0.0.0-fixture'}));fs.writeFileSync(path.join(connector,'lib/index.js'),'');
  fs.writeFileSync(path.join(f.dir,'.dsh/.workbuddy-ai-catalog.json'),JSON.stringify({entries:{'PRIVATE-ACCOUNT':{models:[{id:'cached-model'}]}}}));
  const providers=detectProviders({platform:'win32',home:f.dir,nodePath:process.execPath,env:{PATH:f.dir,APPDATA:path.join(f.dir,'absent')}}),provider=providers.find(p=>p.id==='codex');
  assert.equal(provider.executable,f.entry);assert.equal(provider.mode,'cli');assert.equal(provider.ready,true);
  const auth=createAuthInvocation(provider,{nodePath:process.execPath,platform:'win32'});assert.equal(auth.command,process.execPath);assert.deepEqual(auth.args,[f.entry,'login']);
  const cached=providers.find(p=>p.id==='dsh').models.find(m=>m.id==='workbuddy-ai::cached-model');assert(cached);assert.equal(cached.ready,false);assert.equal(cached.availability,'unknown-account');
  assert.equal(providers.find(p=>p.id==='dsh').connector,undefined);assert(!JSON.stringify(providers).includes('PRIVATE-ACCOUNT'));
});
test('Windows process cancellation uses taskkill process trees with numeric PID and force when requested',async()=>{
  const calls=[];const spawnImpl=(command,args,options)=>{calls.push({command,args,options});const child=new EventEmitter();queueMicrotask(()=>child.emit('close',0));return child;};
  await terminateProcessTree({pid:12345},{platform:'win32',force:true,spawnImpl});
  assert.match(calls[0].command,/taskkill\.exe$/i);assert.deepEqual(calls[0].args,['/PID','12345','/T','/F']);assert.equal(calls[0].options.shell,false);
  await terminateProcessTree({pid:'123 & injected'},{platform:'win32',spawnImpl});assert.equal(calls.length,1);
});
test('Windows discovery detects installed agent executables without starting them or assuming login',t=>{
  const root=fixture(t),programs=path.join(root,'Programs'),app=path.join(programs,'Cursor','Cursor.exe');fs.mkdirSync(path.dirname(app),{recursive:true});fs.writeFileSync(app,'not executable test data');
  const options={home:root,platform:'win32',env:{LOCALAPPDATA:root},roots:[programs]};
  const found=discoverApplications(options);assert.equal(found.length,1);assert.equal(found[0].appPath,app);assert.equal(found[0].mode,'handoff');assert.equal(found[0].ready,false);
  assert.equal(found[0].authStatus,'client-managed');assert.equal(discoverApplications({...options,knownProviders:[{appPath:app.toUpperCase()}]}).length,0);
  const before=discoveryFingerprint(options);fs.utimesSync(programs,new Date(),new Date(Date.now()+3000));assert.notEqual(discoveryFingerprint(options),before);
});
test('Windows workspace protection rejects roots, system folders and credentials case-insensitively',()=>{
  const options={home:'C:\\Users\\Test',platform:'win32',env:{SystemRoot:'C:\\Windows',ProgramFiles:'C:\\Program Files'}};
  for(const folder of ['C:\\','D:\\','C:\\WINDOWS\\System32','C:\\Program Files\\App','C:\\Users\\Test','C:\\USERS\\TEST\\.SSH','C:\\Users\\Test\\AppData\\Roaming\\Account','C:\\Users\\Test\\Projects\\..\\AppData\\Local'])assert.equal(isProtectedWorkspace(folder,options),true,folder);
  assert.equal(isProtectedWorkspace('C:\\Users\\Test\\Projects\\Demo',options),false);assert.equal(isProtectedWorkspace('D:\\Projects\\Demo',options),false);
});
test('Windows telemetry reports its unsupported software sample without stale metrics or spawning Swift',()=>{
  let changed=0;const telemetry=new Telemetry({platform:'win32',helper:'C:\\not-a-windows-binary',onChange:()=>changed++});
  assert.equal(telemetry.get().tokenlens.softwareSamplesSupported,false);
  telemetry.snapshot={recentCalls:[{id:'old'}],tokenlens:{providers:[{id:'old'}]}};telemetry.refresh();
  assert.equal(changed,1);assert.equal(telemetry.child,null);assert.deepEqual(telemetry.get().recentCalls,[]);assert.deepEqual(telemetry.get().tokenlens.providers,[]);
  assert.match(telemetry.get().tokenlens.status,/任务用量仍按实际事件统计/);
  assert.equal(telemetry.get().tokenlens.softwareSamplesSupported,false);
});
test('engine canonicalizes a legitimate data-directory alias but rejects a linked managed workspace root',async t=>{
  const root=fixture(t),real=path.join(root,'real'),alias=path.join(root,'alias');fs.mkdirSync(real);fs.symlinkSync(real,alias,process.platform==='win32'?'junction':'dir');
  const engine=new Engine({dataDir:alias,detectProviders:()=>[],runProvider:async()=>{throw new Error('no inference');}});await engine.init();t.after(()=>engine.shutdown());
  assert.equal(engine.dataDir,fs.realpathSync(real));assert.equal(engine.managedRoot,fs.realpathSync(path.join(real,'workspaces')));
  assert.equal(engine.getState().version,require('../package.json').version);
  const bad=path.join(root,'bad'),outside=path.join(root,'outside');fs.mkdirSync(bad);fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(bad,'workspaces'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(new Engine({dataDir:bad,detectProviders:()=>[],runProvider:async()=>{}}).init(),/不能是符号链接/);
});
test('real Windows cancellation removes an owned Node child and its descendant',{skip:process.platform!=='win32',timeout:10000},async t=>{
  const dir=fixture(t),capture=path.join(dir,'pid');const parent=spawn(process.execPath,['-e',`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(capture)},String(c.pid));setInterval(()=>{},1000)`],{windowsHide:true,stdio:'ignore'});
  t.after(()=>terminateProcessTree(parent,{force:true}));for(let n=0;n<50&&!fs.existsSync(capture);n++)await new Promise(r=>setTimeout(r,50));
  const descendant=Number(fs.readFileSync(capture,'utf8'));await terminateProcessTree(parent,{force:true});
  let alive=true;for(let n=0;n<40;n++){try{process.kill(descendant,0);}catch{alive=false;break;}await new Promise(r=>setTimeout(r,50));}assert.equal(alive,false);
});

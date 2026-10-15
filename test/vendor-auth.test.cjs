'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {prepareVendorInvocation,redactVendorText,resolveWorkBuddyBridge}=require('../lib/vendor-auth.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-vendor-auth-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function values(t,{platform=process.platform==='win32'?'win32':'darwin',region='global',refreshFailure=false}={}){
 const dir=fixture(t),app=platform==='darwin'?path.join(dir,'Applications','WorkBuddy AI.app'):path.join(dir,'Programs','WorkBuddy AI','WorkBuddy AI.exe');
 const resources=platform==='darwin'?path.join(app,'Contents','Resources'):path.join(path.dirname(app),'resources');
 const cli=path.join(resources,'app.asar.unpacked','cli','dist','codebuddy-headless.js');
 const workbuddyElectron=platform==='darwin'?path.join(app,'Contents','MacOS','Electron'):app;
 const dshApp=platform==='darwin'?path.join(dir,'Applications','DeepSeek Harness.app'):path.join(dir,'Programs','DeepSeek Harness');
 const archive=platform==='darwin'?path.join(dshApp,'Contents','Resources','app.asar'):path.join(dshApp,'resources','app.asar');
 const runtimeExecutable=platform==='darwin'?path.join(dshApp,'Contents','MacOS','DeepSeek Harness'):path.join(dshApp,'DeepSeek Harness.exe');
 const connector=path.join(dir,'node_modules','dsh-workbuddy-connect'),entry=path.join(connector,'lib','index.js'),log=path.join(dir,'credential-methods.jsonl');
 for(const file of [entry,cli,workbuddyElectron,runtimeExecutable,archive]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');}
 fs.writeFileSync(path.join(connector,'package.json'),JSON.stringify({name:'dsh-workbuddy-connect',type:'module',version:'0.1.0'}));
 fs.writeFileSync(entry,`import fs from 'node:fs';const log=${JSON.stringify(log)};const record=x=>fs.appendFileSync(log,JSON.stringify(x)+'\\n');
 export const WORKBUDDY_VARIANTS=[{id:'workbuddy-ai'}];export class WorkBuddyUpstreamClient{async refreshToken(){record('refresh');${refreshFailure?"throw new Error('SYNTHETIC_REFRESH_DO_NOT_EXPOSE');":"return {accessToken:'SYNTHETIC_ACCESS_DO_NOT_EXPOSE'};"}}};
 export class WorkBuddyCredentialStore{constructor(options){this.refresh=options.refresh}async current(){record('current');return {accessToken:'SYNTHETIC_EXPIRED_DO_NOT_EXPOSE',expiresAtMs:1,domain:${JSON.stringify(region==='global'?'www.workbuddy.ai':'copilot.tencent.com')}}}async resolve(){record('resolve');const r=await this.refresh();return {...r,expiresAtMs:Date.now()+3600000,refreshToken:'SYNTHETIC_REFRESH_DO_NOT_EXPOSE',uid:'SYNTHETIC_ACCOUNT_DO_NOT_EXPOSE',domain:'www.workbuddy.ai'};}};
 export const regionOf=domain=>domain==='www.workbuddy.ai'?'global':'cn';`);
 fs.writeFileSync(cli,`console.log(JSON.stringify({version:'2.0.0',fresh:process.env.CODEBUDDY_AUTH_TOKEN==='SYNTHETIC_ACCESS_DO_NOT_EXPOSE',input:4089,output:111,debugAccess:process.env.CODEBUDDY_AUTH_TOKEN}));process.stderr.write('SYNTHETIC_REFRESH_DO_NOT_EXPOSE SYNTHETIC_ACCOUNT_DO_NOT_EXPOSE\\n');`);
 return {dir,platform,log,provider:{id:'workbuddy',appPath:app,executable:cli,authBridge:{kind:'workbuddy-desktop-credential',runtimeExecutable,workbuddyElectron,connector:{entry,dshHome:dir,runtimeRoot:path.join(archive,'dsh')}}},
 invocation:{command:process.execPath,args:[cli,'--version'],cwd:dir,stdin:'',env:{HOME:dir,PATH:process.env.PATH,ELECTRON_RUN_AS_NODE:'1',CODEBUDDY_AUTH_TOKEN:'AMBIENT_TOKEN_DO_NOT_EXPOSE',CODEBUDDY_BASE_URL:'https://untrusted.invalid'}}};}
const prepare=(v,provider=v.provider)=>prepareVendorInvocation({provider,invocation:v.invocation,directory:v.dir,platform:v.platform});

test('vendor bridge rejects a different provider or arbitrary CLI before reading credentials',t=>{
 const v=values(t);
 for(const provider of [{...v.provider,id:'codebuddy'},{...v.provider,executable:'/arbitrary'},{...v.provider,authBridge:{kind:'other'}}]){
  assert.throws(()=>prepare(v,provider),/同厂商/);
 }
});

test('vendor bridge reuses and refreshes only the private connector credential without exposing it',t=>{
 const v=values(t),invocation=prepare(v);
 assert.equal(invocation.command,v.provider.authBridge.runtimeExecutable);
 assert.equal(invocation.env.CODEBUDDY_AUTH_TOKEN,undefined);assert.equal(invocation.env.CODEBUDDY_BASE_URL,undefined);
 const script=fs.readFileSync(invocation.args[1],'utf8');
 assert(!JSON.stringify(invocation).includes('AMBIENT_TOKEN'));
 assert(!script.match(/SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_ACCOUNT/));
 assert(script.includes('https://www.workbuddy.ai'));
 assert(script.includes('CODEBUDDY_CREDENTIALS_IN_MEMORY'));
 assert(script.includes("childEnv.CODEBUDDY_DISABLE_PRODUCT_CACHE='1'"));
 assert(script.includes('sdk.regionOf(credential.domain)'));
 if(process.platform!=='win32')assert.equal(fs.statSync(invocation.args[1]).mode&0o777,0o600);
 // Execute only synthetic fixtures. No installed app, account, model or network.
 const output=execFileSync(process.execPath,invocation.args,{cwd:invocation.cwd,env:invocation.env,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
 const result=JSON.parse(output);assert.equal(result.fresh,true);assert.equal(result.input,4089);assert.equal(result.output,111);assert.equal(result.debugAccess,'[redacted]');
 assert(!output.match(/SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_ACCOUNT/));
 assert.deepEqual(fs.readFileSync(v.log,'utf8').trim().split('\n').map(JSON.parse),['current','resolve','refresh']);
});

test('both discovered macOS and Windows resource layouts replace fixed Applications paths',t=>{
 for(const platform of ['darwin','win32']){
  const v=values(t,{platform}),resolved=resolveWorkBuddyBridge(v.provider,{platform}),invocation=prepare(v);
  assert.equal(resolved.runtimeExecutable,v.provider.authBridge.runtimeExecutable);
  assert.equal(invocation.env.WORKBUDDY_AI_ELECTRON_BIN,v.provider.authBridge.workbuddyElectron);
  assert.equal(invocation.env.DSH_HOME,v.dir);assert.equal(invocation.shell,false);
  assert(invocation.command.startsWith(v.dir));assert(!JSON.stringify(invocation).includes('AMBIENT_TOKEN'));
 }
});

test('an arbitrary host, wrong connector package, missing resources and unknown platform fail before credential import',t=>{
 const v=values(t);
 assert.throws(()=>resolveWorkBuddyBridge({...v.provider,authBridge:{...v.provider.authBridge,runtimeExecutable:process.execPath}},{platform:v.platform}),/同厂商/);
 assert.throws(()=>resolveWorkBuddyBridge(v.provider,{platform:'linux'}),/同厂商/);
 fs.writeFileSync(path.join(path.dirname(path.dirname(v.provider.authBridge.connector.entry)),'package.json'),'{"name":"untrusted"}');
 assert.throws(()=>prepare(v),/授权读取器/);assert(!fs.existsSync(v.log));
 const missing=values(t);fs.unlinkSync(missing.provider.authBridge.workbuddyElectron);assert.throws(()=>prepare(missing),/授权读取器/);assert(!fs.existsSync(missing.log));
});

test('a foreign-region or failed-refresh credential never launches the headless CLI or leaks its failure',t=>{
 for(const options of [{region:'cn'},{refreshFailure:true}]){
  const v=values(t,options),invocation=prepare(v);let error;
  try{execFileSync(process.execPath,invocation.args,{cwd:invocation.cwd,env:invocation.env,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});}catch(e){error=e;}
  assert.equal(error?.status,1);assert.equal(error.stdout,'');assert.match(error.stderr,/现有桌面授权不可用/);assert.doesNotMatch(error.stderr,/SYNTHETIC|copilot|token/);
  const calls=fs.readFileSync(v.log,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls,options.region==='cn'?['current']:['current','resolve','refresh']);
 }
});

test('Windows Path casing is retained but ambient auth and product overrides are stripped',t=>{
 const v=values(t,{platform:'win32'});v.invocation.env={home:v.dir,Path:process.env.PATH,SystemRoot:'C:\\Windows',CODEBUDDY_AUTH_TOKEN:'AMBIENT_TOKEN',NODE_OPTIONS:'--require injected',ACC_PRODUCT_CONFIG_V3:'SYNTHETIC_OVERRIDDEN_PRODUCT'};
 const result=prepare(v);assert.equal(result.env.PATH,process.env.PATH);assert.equal(result.env.HOME,v.dir);assert.equal(result.env.SystemRoot,'C:\\Windows');
 for(const key of ['CODEBUDDY_AUTH_TOKEN','NODE_OPTIONS','ACC_PRODUCT_CONFIG_V3'])assert.equal(result.env[key],undefined);
});


test('private credential and identity redaction preserves usage while removing exact secrets',()=>{
 const input=JSON.stringify({token:'SYNTHETIC_ACCESS',refresh:'SYNTHETIC_REFRESH',uid:'SYNTHETIC_ACCOUNT',nickname:'Private Name',input:4089,output:111});
 const text=redactVendorText(input,['SYNTHETIC_ACCESS','SYNTHETIC_REFRESH','SYNTHETIC_ACCOUNT','Private Name']);
 assert(!text.match(/SYNTHETIC|Private Name/));assert.equal(JSON.parse(text).input,4089);assert.equal(JSON.parse(text).output,111);
 assert.equal(redactVendorText('Authorization: Bearer unexpected-token'),'Authorization: Bearer [redacted]');
});

test('vendor endpoint guard blocks authorization to another host, cleartext, or a nonstandard port before networking',t=>{
 const v=values(t);prepare(v);
 const guard=path.join(v.dir,'workbuddy-endpoint-guard.mjs');
 const source=`const https=require('node:https');let blocked=0;const headers={Authorization:'Bearer SYNTHETIC_GUARD_TOKEN'};
 for(const url of ['https://untrusted.invalid','http://www.workbuddy.ai','https://www.workbuddy.ai:4443']){try{fetch(url,{headers});}catch(e){if(e.message==='WorkBuddy authorization endpoint rejected.')blocked++;}}
 try{https.request('https://untrusted.invalid',{headers});}catch(e){if(e.message==='WorkBuddy authorization endpoint rejected.')blocked++;}
 try{https.get('https://untrusted.invalid',{headers});}catch(e){if(e.message==='WorkBuddy authorization endpoint rejected.')blocked++;}
 const http=require('node:http');for(const method of ['setHeader','appendHeader','write','end','flushHeaders']){const fake=Object.create(http.ClientRequest.prototype);fake.getHeaders=()=>headers;try{fake[method](...(method==='setHeader'||method==='appendHeader'?['Authorization',headers.Authorization]:[]));}catch(e){if(e.message==='WorkBuddy authorization endpoint rejected.')blocked++;}}
 const valid=https.request('https://www.workbuddy.ai',{headers});valid.on('error',()=>{});valid.destroy();
 console.log(JSON.stringify({blocked}));`;
 const output=execFileSync(process.execPath,['--import',pathToFileURL(guard).href,'-e',source],{env:{...process.env,CODEBUDDY_AUTH_TOKEN:'SYNTHETIC_GUARD_TOKEN'},encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});
 assert.deepEqual(JSON.parse(output.trim()),{blocked:10});assert(!output.includes('SYNTHETIC_GUARD_TOKEN'));
});


test('authorization fetch always disables redirects, including a caller-supplied Request and follow option',t=>{
 const dir=fixture(t),guard=path.resolve(__dirname,'../lib/vendor-endpoint-guard.mjs');
 const source=`globalThis.fetch=(input,options)=>Promise.resolve({redirect:options?.redirect||'default'});
 (async()=>{await import(require('node:url').pathToFileURL(${JSON.stringify(guard)}).href);
 const headers={Authorization:'Bearer SYNTHETIC_GUARD_TOKEN'};
 const a=await fetch('https://www.workbuddy.ai',{headers,redirect:'follow'});
 const b=await fetch(new Request('https://www.workbuddy.ai',{headers,redirect:'follow'}));
 const c=await fetch('http://localhost',{headers:{Accept:'text/plain'},redirect:'follow'});
 console.log(JSON.stringify([a.redirect,b.redirect,c.redirect]));})();`;
 const output=execFileSync(process.execPath,['-e',source],{cwd:dir,env:{...process.env,CODEBUDDY_AUTH_TOKEN:'SYNTHETIC_GUARD_TOKEN'},encoding:'utf8',timeout:5000});
 assert.deepEqual(JSON.parse(output),['error','error','follow']);
});

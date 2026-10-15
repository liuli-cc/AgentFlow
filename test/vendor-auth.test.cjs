'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {prepareVendorInvocation,redactVendorText}=require('../lib/vendor-auth.cjs');
const app='/Applications/WorkBuddy AI.app',cli=path.join(app,'Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-headless.js');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-vendor-auth-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function values(t){const dir=fixture(t),entry=path.join(dir,'connector.mjs');
 fs.writeFileSync(entry,`export const WORKBUDDY_VARIANTS=[{id:'workbuddy-ai'}];export class WorkBuddyUpstreamClient{};
 export class WorkBuddyCredentialStore{async current(){return {accessToken:'SYNTHETIC_ACCESS_DO_NOT_EXPOSE',refreshToken:'SYNTHETIC_REFRESH_DO_NOT_EXPOSE',uid:'SYNTHETIC_ACCOUNT_DO_NOT_EXPOSE',domain:'www.workbuddy.ai'};}};
 export const regionOf=domain=>domain==='www.workbuddy.ai'?'global':'cn';`);
 return {dir,provider:{id:'workbuddy',executable:cli,authBridge:{kind:'workbuddy-desktop-credential',connector:{entry,dshHome:dir,runtimeRoot:'/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'}}},
 invocation:{command:process.execPath,args:[cli,'--version'],cwd:dir,stdin:'',env:{HOME:dir,PATH:process.env.PATH,ELECTRON_RUN_AS_NODE:'1',CODEBUDDY_AUTH_TOKEN:'AMBIENT_TOKEN_DO_NOT_EXPOSE',CODEBUDDY_BASE_URL:'https://untrusted.invalid'}}};}

test('vendor bridge rejects a different provider or arbitrary CLI before reading credentials',t=>{
 const v=values(t);
 for(const provider of [{...v.provider,id:'codebuddy'},{...v.provider,executable:'/arbitrary'},{...v.provider,authBridge:{kind:'other'}}]){
  assert.throws(()=>prepareVendorInvocation({provider,invocation:v.invocation,directory:v.dir}),/同厂商/);
 }
});

test('vendor bridge invocation and temporary source contain no credential or account value',{
 skip:!fs.existsSync(cli)||!fs.existsSync('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness')
},t=>{
 const v=values(t),invocation=prepareVendorInvocation({provider:v.provider,invocation:v.invocation,directory:v.dir});
 assert.equal(invocation.command,'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness');
 assert.equal(invocation.env.CODEBUDDY_AUTH_TOKEN,undefined);assert.equal(invocation.env.CODEBUDDY_BASE_URL,undefined);
 const script=fs.readFileSync(invocation.args[1],'utf8');
 assert(!JSON.stringify(invocation).includes('AMBIENT_TOKEN'));
 assert(!script.match(/SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_ACCOUNT/));
 assert(script.includes('https://www.workbuddy.ai'));
 assert(script.includes('CODEBUDDY_CREDENTIALS_IN_MEMORY'));
 assert(script.includes("childEnv.CODEBUDDY_DISABLE_PRODUCT_CACHE='1'"));
 assert(script.includes('sdk.regionOf(credential.domain)'));
 assert.equal(fs.statSync(invocation.args[1]).mode&0o777,0o600);
 // --version executes the original vendor CLI with a synthetic in-memory
 // credential: no model call, real desktop store, or network authentication.
 const output=execFileSync(invocation.command,invocation.args,{cwd:invocation.cwd,env:invocation.env,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
 assert.match(output,/\d+\.\d+/);assert(!output.match(/SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_ACCOUNT/));
});


test('private credential and identity redaction preserves usage while removing exact secrets',()=>{
 const input=JSON.stringify({token:'SYNTHETIC_ACCESS',refresh:'SYNTHETIC_REFRESH',uid:'SYNTHETIC_ACCOUNT',nickname:'Private Name',input:4089,output:111});
 const text=redactVendorText(input,['SYNTHETIC_ACCESS','SYNTHETIC_REFRESH','SYNTHETIC_ACCOUNT','Private Name']);
 assert(!text.match(/SYNTHETIC|Private Name/));assert.equal(JSON.parse(text).input,4089);assert.equal(JSON.parse(text).output,111);
 assert.equal(redactVendorText('Authorization: Bearer unexpected-token'),'Authorization: Bearer [redacted]');
});

test('vendor endpoint guard blocks authorization to another host, cleartext, or a nonstandard port before networking',{
 skip:!fs.existsSync(cli)||!fs.existsSync('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness')
},t=>{
 const v=values(t);prepareVendorInvocation({provider:v.provider,invocation:v.invocation,directory:v.dir});
 const guard=path.join(v.dir,'workbuddy-endpoint-guard.mjs');
 const source=`const https=require('node:https');let blocked=0;const headers={Authorization:'Bearer SYNTHETIC_GUARD_TOKEN'};
 for(const url of ['https://untrusted.invalid','http://www.workbuddy.ai','https://www.workbuddy.ai:4443']){try{fetch(url,{headers});}catch(e){if(e.message==='WorkBuddy authorization endpoint rejected.')blocked++;}}
 try{https.request('https://untrusted.invalid',{headers});}catch(e){if(e.message==='WorkBuddy authorization endpoint rejected.')blocked++;}
 try{https.get('https://untrusted.invalid',{headers});}catch(e){if(e.message==='WorkBuddy authorization endpoint rejected.')blocked++;}
 const http=require('node:http');for(const method of ['setHeader','appendHeader','write','end','flushHeaders']){const fake=Object.create(http.ClientRequest.prototype);fake.getHeaders=()=>headers;try{fake[method](...(method==='setHeader'||method==='appendHeader'?['Authorization',headers.Authorization]:[]));}catch(e){if(e.message==='WorkBuddy authorization endpoint rejected.')blocked++;}}
 const valid=https.request('https://www.workbuddy.ai',{headers});valid.on('error',()=>{});valid.destroy();
 console.log(JSON.stringify({blocked}));`;
 const output=execFileSync(process.execPath,['--import',guard,'-e',source],{env:{...process.env,CODEBUDDY_AUTH_TOKEN:'SYNTHETIC_GUARD_TOKEN'},encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});
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

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {detectGoogleProviders,buildGoogleInvocation,parseGoogleEvent,googleAuthInvocation,describeGoogleAuth}=require('../lib/google-agents.cjs');

// The native header and runner below are synthetic discovery fixtures. No
// Google account, browser, keyring, or inference is used by these tests.
function fixture(t){
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-google-fixture-')));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const agy=path.join(home,process.platform==='win32'?'agy.exe':'agy');fs.writeFileSync(agy,Buffer.from(process.platform==='win32'?'4d5a000000000000':'cffaedfe00000000','hex'),{mode:0o700});
  const directory=path.join(home,'node_modules/@google/gemini-cli'),gemini=path.join(directory,'dist/index.js');fs.mkdirSync(path.dirname(gemini),{recursive:true});
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'@google/gemini-cli',version:'0.64.0',bin:{gemini:'dist/index.js'}}));fs.writeFileSync(gemini,'#!/usr/bin/env node\n',{mode:0o700});
  return {home,agy,gemini};
}
const help='Antigravity CLI\nCommands:\n  auth Manage authentication\n  models List models\nOptions:\n --print --output-format --input-format --mode (default, plan, accept-edits)';
function detect(f,{loggedIn=true,models=true,withStatus=true,env={},platform=process.platform}={}){
  const calls=[];
  const result=detectGoogleProviders({home:f.home,platform,env,nodePath:process.execPath,findCLI:name=>name==='gemini'?f.gemini:name==='agy'?f.agy:null,runner:invocation=>{
    calls.push(invocation);
    if(invocation.args.includes(f.gemini))return {status:0,stdout:'Gemini CLI --prompt --output-format --approval-mode plan --policy --admin-policy'};
    const args=invocation.args.join(' ');
    if(args==='--help')return {status:0,stdout:help};
    if(args==='auth --help')return {status:0,stdout:withStatus?'Commands:\n  status Show authentication state':'Commands:\n  login Sign in'};
    if(args==='auth status')return {status:loggedIn?0:1,stdout:loggedIn?'Authenticated: true':'Not logged in',stderr:''};
    if(args==='models --output-format json')return {status:0,stdout:JSON.stringify(models?{models:[{slug:'gemini-fixture-high',display_name:'Fixture High',efforts:['low','high']}]}:{models:[]})};
    throw new Error('Unexpected command: '+args);
  }});
  return {providers:result,calls};
}
test('missing CLI and IDE-only discovery never imply logged out or ready',()=>{
  const providers=detectGoogleProviders({applications:[{name:'Antigravity',appPath:'/Applications/Antigravity.app'}],findCLI:()=>null,runner:()=>{throw new Error('must not run');}});
  const agy=providers.find(row=>row.id==='antigravity');assert.equal(agy.ready,false);assert.equal(agy.mode,'handoff');assert.equal(agy.authStatus,'client-managed');assert.equal(agy.adapterStatus,'unavailable');assert.match(agy.message,/原应用/);
});
test('Gemini official package and API key presence remain unverified and no key is returned',t=>{
  const f=fixture(t),result=detect(f,{env:{GEMINI_API_KEY:'SYNTHETIC_PRIVATE_API_KEY'}}),gemini=result.providers[0];
  assert.equal(gemini.cliAvailable,true);assert.equal(gemini.authStatus,'configured');assert.equal(gemini.ready,false);assert(!JSON.stringify(gemini).includes('SYNTHETIC_PRIVATE_API_KEY'));assert.equal(gemini.capabilities.probe,true);
  assert(result.calls.every(call=>!call.args.includes('--prompt')&&!call.args.includes('-p')));
});
test('lookalike Gemini npm package is not accepted',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(path.dirname(path.dirname(f.gemini)),'package.json'),JSON.stringify({name:'unofficial-gemini',bin:{gemini:'dist/index.js'}}));
  assert.equal(detect(f).providers[0].cliAvailable,false);
});
test('older or unaudited Gemini schemas cannot enable a supposedly safe probe',t=>{
  const f=fixture(t),file=path.join(path.dirname(path.dirname(f.gemini)),'package.json');
  for(const version of ['0.63.0','0.65.0','0.64.0-preview.1','1.0.0']){fs.writeFileSync(file,JSON.stringify({name:'@google/gemini-cli',version,bin:{gemini:'dist/index.js'}}));const provider=detect(f).providers[0];assert.equal(provider.capabilities.probe,false);assert.match(provider.message,/尚未核验/);}
});
test('Gemini reads only public auth selection or cache metadata as configured, never as verified',t=>{
  const f=fixture(t),custom=path.join(f.home,'custom');fs.mkdirSync(path.join(custom,'.gemini'),{recursive:true});
  fs.writeFileSync(path.join(custom,'.gemini','settings.json'),JSON.stringify({security:{auth:{selectedType:'oauth-personal'}},SYNTHETIC_PRIVATE_FIELD:'DO_NOT_RETURN'}));
  const provider=detect(f,{env:{GEMINI_CLI_HOME:custom}}).providers[0];assert.equal(provider.authStatus,'configured');assert.equal(provider.ready,false);assert(!JSON.stringify(provider).includes('DO_NOT_RETURN'));
  fs.writeFileSync(path.join(custom,'.gemini','settings.json'),'{}');fs.writeFileSync(path.join(custom,'.gemini','oauth_creds.json'),'SYNTHETIC_TOKEN_NOT_READ');
  assert.equal(detect(f,{env:{GEMINI_CLI_HOME:custom}}).providers[0].authStatus,'configured');
});
test('Google discovery forwards only product-owned environment, excluding Node injection and unrelated secrets',t=>{
  const f=fixture(t),{calls}=detect(f,{env:{PATH:'/fixture',HTTPS_PROXY:'http://127.0.0.1:7890',NODE_OPTIONS:'--require unsafe',NODE_PATH:'/unsafe',OPENAI_API_KEY:'OTHER_SECRET',GEMINI_API_KEY:'GEMINI_ONLY',GOOGLE_CLOUD_PROJECT:'fixture-project'}});
  for(const call of calls){assert.equal(call.env.NODE_OPTIONS,undefined);assert.equal(call.env.NODE_PATH,undefined);assert.equal(call.env.OPENAI_API_KEY,undefined);assert.equal(call.env.HTTPS_PROXY,'http://127.0.0.1:7890');if(call.args.includes(f.gemini))assert.equal(call.env.GEMINI_API_KEY,'GEMINI_ONLY');else assert.equal(call.env.GEMINI_API_KEY,undefined);}
});
test('agy explicit authenticated status plus model directory enables supported CLI',t=>{
  const f=fixture(t),{providers,calls}=detect(f),agy=providers[1];assert.equal(agy.ready,true);assert.equal(agy.authStatus,'configured');assert.equal(agy.models[0].id,'gemini-fixture-high');assert.equal(agy.models[0].ready,true);assert.deepEqual(agy.models[0].efforts,['default','low','high']);assert(calls.some(call=>call.args.join(' ')==='auth status'));
});
test('model catalog alone never authenticates the CLI',t=>{
  const f=fixture(t),agy=detect(f,{withStatus:false}).providers[1];assert.equal(agy.ready,false);assert.equal(agy.authStatus,'unknown');assert(agy.models.every(model=>!model.ready));
});
test('new agy uses advertised no-inference quota report when auth status is absent',t=>{
  const f=fixture(t),calls=[];
  const result=detectGoogleProviders({home:f.home,nodePath:process.execPath,env:{},findCLI:name=>name==='agy'?f.agy:null,runner:invocation=>{
    const args=invocation.args.join(' ');calls.push(args);
    if(args==='--help')return {status:0,stdout:help.replace('  auth Manage authentication\n','')};
    if(args==='--version')return {status:0,stdout:'Antigravity CLI 1.3.5'};
    if(args==='-p /help --output-format json')return {status:0,stdout:JSON.stringify({commands:['/help','/usage']})};
    if(args==='-p /usage --output-format json')return {status:0,stdout:JSON.stringify({command:'usage',model_quotas:[{model:'gemini-real-slug',remaining_fraction:0}]})};
    if(args==='models --output-format json')return {status:0,stdout:JSON.stringify([{slug:'gemini-real-slug',name:'Actual catalog'}])};
    throw new Error('Unexpected command');
  }}).find(row=>row.id==='antigravity');
  assert.equal(result.ready,true);assert.equal(result.authStatus,'configured');assert(calls.includes('-p /usage --output-format json'));assert(!calls.some(call=>call.includes('auth status')));
});
test('negative status and absent models cannot be ready',t=>{
  const f=fixture(t);assert.equal(detect(f,{loggedIn:false}).providers[1].ready,false);const agy=detect(f,{models:false}).providers[1];assert.equal(agy.ready,false);assert.equal(agy.authStatus,'configured');assert.equal(agy.readinessReason.code,'catalog-unavailable');
});
test('script named agy and IDE launcher are rejected before a status call',t=>{
  const f=fixture(t);fs.writeFileSync(f.agy,'#!/bin/sh\necho Antigravity',{mode:0o700});const {providers,calls}=detect(f);assert.equal(providers[1].cliAvailable,false);assert(!calls.some(call=>call.command===f.agy));
});
test('builder uses closed-stdin stream input and official plan mode with exact model and effort',t=>{
  const f=fixture(t),provider=detect(f).providers[1],prompt='需求\n含引号 " 和 $()';
  const invocation=buildGoogleInvocation({provider,stage:{role:'review',model:'gemini-fixture-high',effort:'high'},prompt,workspace:f.home,env:{PATH:'/synthetic'}});
  assert.equal(invocation.command,f.agy);assert.equal(invocation.shell,false);assert.equal(invocation.cwd,f.home);assert.equal(invocation.protocol,'antigravity');assert.equal(invocation.args[invocation.args.indexOf('--mode')+1],'plan');assert(!invocation.args.includes('--dangerously-skip-permissions'));assert.equal(JSON.parse(invocation.stdin).message.content,prompt);assert.deepEqual(invocation.selection,{modelId:'gemini-fixture-high',effort:'high'});
  assert.throws(()=>buildGoogleInvocation({provider,stage:{probe:true},prompt,workspace:f.home}),/禁工具/);
  assert.throws(()=>buildGoogleInvocation({provider,stage:{model:'not-in-catalog'},prompt,workspace:f.home}),/授权目录/);
  assert.throws(()=>buildGoogleInvocation({provider,stage:{model:'gemini-fixture-high',effort:'ultra'},prompt,workspace:f.home}),/思考强度/);
  for(const stage of [{role:'acceptance'},{kind:'验收'},{id:'规划'}]){
    const value=buildGoogleInvocation({provider,stage,prompt,workspace:f.home});assert.equal(value.args[value.args.indexOf('--mode')+1],'plan');
  }
  const design=buildGoogleInvocation({provider,stage:{role:'design'},prompt,workspace:f.home});assert.equal(design.args[design.args.indexOf('--mode')+1],'default');
});
test('Gemini builder requires explicit verified state, rejects unverified effort, and keeps prompt off argv',t=>{
  const f=fixture(t),provider=detect(f).providers[0];assert.throws(()=>buildGoogleInvocation({provider,prompt:'test',workspace:f.home}),/尚未确认/);
  provider.ready=true;provider.models[0].ready=true;
  const invocation=buildGoogleInvocation({provider,stage:{role:'plan'},prompt:'full actual prompt',workspace:f.home});assert.equal(invocation.stdin,'full actual prompt');assert(!invocation.args.includes('full actual prompt'));assert(invocation.args.includes('plan'));assert.equal(invocation.command,process.execPath);
});
test('Gemini explicit probe uses fixed OK, private deny-all policy and disables startup integrations',t=>{
  const f=fixture(t),provider=detect(f,{env:{GEMINI_API_KEY:'fixture'}}).providers[0];assert.equal(provider.ready,false);assert.equal(provider.capabilities.probe,true);
  const invocation=buildGoogleInvocation({provider,stage:{probe:true},prompt:'ignore this unsafe prompt',workspace:f.home,env:{HOME:f.home,GEMINI_API_KEY:'SYNTHETIC_PRIVATE_KEY',OPENAI_API_KEY:'OTHER_SECRET',NODE_OPTIONS:'unsafe'}});
  t.after(()=>invocation.cleanup());assert.equal(invocation.stdin,'Reply exactly OK. Do not use any tools.');assert.notEqual(invocation.cwd,f.home);assert.equal(invocation.env.HOME,f.home);assert.equal(invocation.env.GEMINI_API_KEY,'SYNTHETIC_PRIVATE_KEY');assert.equal(invocation.env.OPENAI_API_KEY,undefined);assert.equal(invocation.env.NODE_OPTIONS,undefined);assert.equal(invocation.env.GEMINI_CLI_TRUST_WORKSPACE,'true');
  const policyFile=invocation.args[invocation.args.indexOf('--admin-policy')+1],policy=fs.readFileSync(policyFile,'utf8');assert.match(policy,/toolName = "\*"/);assert.match(policy,/decision = "deny"/);assert.match(policy,/priority = 999/);if(process.platform!=='win32')assert.equal(fs.statSync(policyFile).mode&0o777,0o600);
  const config=JSON.parse(fs.readFileSync(path.join(invocation.cwd,'.gemini/settings.json'),'utf8'));assert.equal(config.hooksConfig.enabled,false);assert.equal(config.admin.mcp.enabled,false);assert.equal(config.admin.extensions.enabled,false);assert.equal(config.admin.skills.enabled,false);assert.equal(config.tools.discoveryCommand,'');assert.equal(config.tools.callCommand,'');assert.equal(config.mcp.serverCommand,'');assert.deepEqual(config.context.fileName,[]);
  assert(!JSON.stringify(config).includes('SYNTHETIC_PRIVATE_KEY'));const privateCwd=invocation.cwd;invocation.cleanup();assert.equal(fs.existsSync(privateCwd),false);invocation.cleanup();
});
test('Gemini probe refuses a system-managed override rather than weakening it',t=>{
  const f=fixture(t),managed=path.join(f.home,'managed-settings.json');fs.writeFileSync(managed,'{}');const provider=detect(f).providers[0];
  assert.throws(()=>buildGoogleInvocation({provider,stage:{probe:true},prompt:'test',workspace:f.home,env:{GEMINI_CLI_SYSTEM_SETTINGS_PATH:managed}}),/系统管理/);
  assert.equal(detect(f,{env:{GEMINI_CLI_SYSTEM_SETTINGS_PATH:managed}}).providers[0].capabilities.probe,false);
});
test('authentication invocation delegates to a terminal without inventing OAuth or exporting a credential',t=>{
  const f=fixture(t),provider=detect(f).providers[1];const auth=describeGoogleAuth(provider);assert.equal(auth.kind,'browser-cli');assert.equal(auth.requiresTerminal,true);const invocation=googleAuthInvocation(provider,{env:{PATH:'/fixture'}});assert.deepEqual(invocation.args,[]);assert.equal(invocation.requiresTerminal,true);assert.equal(invocation.interactive,true);assert.equal(invocation.shell,false);
});
// Output examples use the public official headless docs and core/output/types.ts.
test('official Antigravity stream parsing only exposes public response deltas and final usage once',()=>{
  assert.deepEqual(parseGoogleEvent({event:'init',conversation_id:'conversation',init:{model:'official-slug'}},'antigravity'),{sessionId:'conversation',modelId:'official-slug'});
  const step=parseGoogleEvent({event:'step_update',step_update:{conversation_id:'conversation',step_index:3,step_type:'agent_response',state:'ACTIVE',text_delta:'公开回复'}},'antigravity');assert.equal(step.appendText,true);assert.equal(step.messageId,'3');assert.equal(step.text,'公开回复');assert.equal(step.usage,undefined);
  assert.deepEqual(parseGoogleEvent({event:'step_update',step_update:{step_type:'thinking',text_delta:'private reasoning'}},'antigravity'),{});
  const result=parseGoogleEvent({event:'result',result:{conversation_id:'conversation',status:'SUCCESS',response:'最终回复',usage:{input_tokens:10418,output_tokens:589,thinking_tokens:551,cache_read_tokens:8113,total_tokens:11007}}},'antigravity');
  assert.equal(result.success,true);assert.equal(result.terminal,true);assert.equal(result.appendText,false);assert.deepEqual(result.usage,{input:10418,output:589,reasoning:551,cacheRead:8113,cacheWrite:null,costUSD:null});
});
test('Antigravity failures and nonterminal statuses never pass final verification',()=>{
  for(const status of ['ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING']){const parsed=parseGoogleEvent({event:'result',result:{status,response:'partial',error:'authentication required'}},'antigravity');assert.equal(parsed.terminal,true);assert.equal(parsed.success,false);}
});
test('Gemini stream handles actual model, delta semantics, warning and explicit terminal result',()=>{
  assert.equal(parseGoogleEvent({type:'init',session_id:'session',model:'actual-model'},'gemini').modelId,'actual-model');
  assert.deepEqual(parseGoogleEvent({type:'message',role:'user',content:'input'},'gemini'),{});
  assert.equal(parseGoogleEvent({type:'message',role:'assistant',content:'hello',delta:true},'gemini').appendText,true);
  assert.equal(parseGoogleEvent({type:'error',severity:'warning',message:'notice'},'gemini').terminal,undefined);
  const result=parseGoogleEvent({type:'result',status:'success',stats:{input_tokens:200,output_tokens:50,cached:120,input:80}},'gemini');assert.equal(result.success,true);assert.deepEqual(result.usage,{input:200,output:50,cacheRead:120,cacheWrite:null,reasoning:null,costUSD:null});
});
test('Gemini JSON per-model usage preserves unknowns, cache subset and known zeros',()=>{
  const parsed=parseGoogleEvent({session_id:'id',response:'OK',stats:{models:{one:{tokens:{prompt:100,candidates:5,cached:80,thoughts:0}},two:{tokens:{prompt:20,candidates:0,cached:0}}}}},'gemini');
  assert.equal(parsed.usage.input,120);assert.equal(parsed.usage.output,5);assert.equal(parsed.usage.cacheRead,80);assert.equal(parsed.usage.reasoning,null);assert.equal(parsed.success,true);
  assert.equal(parseGoogleEvent({type:'result',status:'error',error:{message:'access_token=DO_NOT_EXPOSE'}},'gemini').error,'access_token=[redacted]');
});

 test('probe rechecks installed package version after discovery and refuses an unreviewed upgrade',t=>{
  const f=fixture(t),provider=detect(f).providers[0];
  assert.equal(provider.capabilities.probe,true);
  const packageFile=path.join(path.dirname(path.dirname(f.gemini)),'package.json');
  const metadata=JSON.parse(fs.readFileSync(packageFile,'utf8'));metadata.version='0.65.0';fs.writeFileSync(packageFile,JSON.stringify(metadata));
  assert.throws(()=>buildGoogleInvocation({provider,stage:{probe:true},prompt:'test',workspace:f.home}),/版本已变化/);
 });

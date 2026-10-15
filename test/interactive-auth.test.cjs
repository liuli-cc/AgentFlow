'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {launchInteractiveAuth,terminalEnvironment}=require('../lib/interactive-auth.cjs');
const nativePlatform=process.platform==='win32'?'win32':'darwin';
function fixture(t){
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-terminal-test-'))),directory=path.join(base,"quoted ' $() fixture");fs.mkdirSync(directory);
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  return {base,directory};
}
function shellLauncher(calls=[]){return (command,args,options)=>{calls.push({command,args,options});assert.equal(command,'/usr/bin/open');assert.deepEqual(args.slice(0,2),['-a','Terminal']);return spawn('/bin/sh',[args[2]],{env:options.env,stdio:'ignore',shell:false});};}
test('terminal environment excludes credentials and Node startup injection',()=>{
  const clean=terminalEnvironment({PATH:'/bin',HOME:'/fixture',GEMINI_API_KEY:'SYNTHETIC_SECRET',NODE_OPTIONS:'--require unsafe',NODE_PATH:'/unsafe',ELECTRON_RUN_AS_NODE:'1',ACCESS_TOKEN:'SYNTHETIC_TOKEN'});
  assert.deepEqual(clean,{PATH:'/bin',HOME:'/fixture'});
});
test('ordinary local proxies and custom config home are preserved, credential proxies fail without disclosure',()=>{
  const values={HTTPS_PROXY:'http://127.0.0.1:7890',http_proxy:'socks5://localhost:1080',ALL_PROXY:'socks5h://127.0.0.1:1080',NO_PROXY:'localhost,127.0.0.1,::1,10.0.0.0/8',GEMINI_CLI_HOME:'/private/fixture gemini'};
  assert.deepEqual(terminalEnvironment(values),values);
  assert.equal(terminalEnvironment({GEMINI_CLI_HOME:'C:\\Users\\Fixture\\.gemini'},{platform:'win32'}).GEMINI_CLI_HOME,'C:\\Users\\Fixture\\.gemini');
  for(const proxy of ['http://SYNTHETIC_USER:SYNTHETIC_PASSWORD@proxy:8080','http://proxy:8080/?token=SYNTHETIC_TOKEN'])assert.throws(()=>terminalEnvironment({HTTP_PROXY:proxy}),error=>/代理/.test(error.message)&&!error.message.includes('SYNTHETIC'));
  assert.throws(()=>terminalEnvironment({GEMINI_CLI_HOME:'relative'}),/绝对路径/);
});
test('Mac quoted command runs real fixed runner and returns private completion metadata',{skip:process.platform==='win32'},async t=>{
  const f=fixture(t),cli=path.join(f.directory,'fake official cli.cjs'),marker=path.join(f.directory,'marker.json'),calls=[];
  fs.writeFileSync(cli,"require('node:fs').writeFileSync(process.argv[2], JSON.stringify({cwd:process.cwd(),secret:process.env.GEMINI_API_KEY,nodeOptions:process.env.NODE_OPTIONS}));");
  const auth=launchInteractiveAuth({platform:'darwin',home:f.directory,nodePath:process.execPath,baseDirectory:f.base,invocation:{command:process.execPath,args:[cli,marker],env:{GEMINI_API_KEY:'SYNTHETIC_SECRET',NODE_OPTIONS:'--require /never'}},spawnImpl:shellLauncher(calls),timeoutMs:3000,pollIntervalMs:20});
  const privateFiles=fs.readdirSync(auth.directory);assert(privateFiles.includes('login.command'));assert.equal(fs.statSync(auth.directory).mode&0o777,0o700);assert.equal(fs.statSync(path.join(auth.directory,'invocation.json')).mode&0o777,0o600);
  const saved=fs.readFileSync(path.join(auth.directory,'invocation.json'),'utf8');assert(!saved.includes('SYNTHETIC_SECRET'));assert(!saved.includes('NODE_OPTIONS'));assert.match(fs.readFileSync(path.join(auth.directory,'login.command'),'utf8'),/unset NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE/);
  const result=await auth.completion;assert.equal(result.code,0);assert.equal(result.cancelled,false);assert.deepEqual(JSON.parse(fs.readFileSync(marker,'utf8')),{cwd:f.directory});assert.equal(calls[0].options.shell,false);await auth.cleanup();assert.equal(fs.existsSync(auth.directory),false);
});
test('Windows uses conhost and discrete arguments without cmd or shell expansion',async t=>{
  const f=fixture(t),calls=[];const auth=launchInteractiveAuth({platform:'win32',home:'C:\\Users\\Fixture',nodePath:'C:\\Program Files\\Node\\node.exe',baseDirectory:f.base,env:{SystemRoot:'C:\\Windows'},invocation:{command:'C:\\Official CLI\\agy.exe',args:[]},timeoutMs:3000,pollIntervalMs:20,spawnImpl:(command,args,options)=>{
    calls.push({command,args,options});const child=new EventEmitter();child.pid=123;
    const config=JSON.parse(fs.readFileSync(args[2],'utf8'));setTimeout(()=>{fs.writeFileSync(path.join(path.dirname(args[2]),'result.json'),JSON.stringify({nonce:config.nonce,code:0,signal:null}));child.emit('close',0);},30);return child;
  }});
  assert.equal(calls[0].command,'C:\\Windows\\System32\\conhost.exe');assert.equal(calls[0].args[0],'C:\\Program Files\\Node\\node.exe');assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.windowsHide,false);assert(!calls[0].args.some(arg=>arg==='cmd.exe'));assert.equal((await auth.completion).code,0);await auth.cleanup();
});
test('actual runner cancellation stops waiting CLI and reports cancellation',async t=>{
  const f=fixture(t),cli=path.join(f.directory,'wait.cjs');fs.writeFileSync(cli,'setInterval(()=>{},1000)');
  const platform=process.platform==='win32'?'win32':'darwin';
  const launcher=platform==='win32'?(command,args,options)=>spawn(process.execPath,[args[1],args[2]],{env:options.env,stdio:'ignore',shell:false}):shellLauncher();
  const auth=launchInteractiveAuth({platform,home:f.directory,nodePath:process.execPath,baseDirectory:f.base,invocation:{command:process.execPath,args:[cli]},spawnImpl:launcher,timeoutMs:5000,pollIntervalMs:20});
  for(let i=0;i<100&&!fs.existsSync(path.join(auth.directory,'pid.json'));i++)await new Promise(resolve=>setTimeout(resolve,10));
  const pid=JSON.parse(fs.readFileSync(path.join(auth.directory,'pid.json'),'utf8')).pid;
  await auth.cancel();const result=await auth.completion;assert.equal(result.cancelled,true);assert.equal(result.timedOut,false);assert.throws(()=>process.kill(pid,0));await auth.cleanup();
});
test('timeout and cleanup before terminal startup settle without leaving config files',async t=>{
  const f=fixture(t),auth=launchInteractiveAuth({platform:nativePlatform,home:f.directory,nodePath:process.execPath,baseDirectory:f.base,invocation:{command:process.execPath,args:[]},spawnImpl:()=>new EventEmitter(),timeoutMs:100,pollIntervalMs:20});
  const result=await auth.completion;assert.equal(result.timedOut,true);assert.equal(result.cancelled,true);await auth.cleanup();assert.equal(fs.existsSync(auth.directory),false);
});
test('spawn errors reject completion and can be cleaned, a successful open alone never completes login',async t=>{
  const f=fixture(t);let child;const auth=launchInteractiveAuth({platform:nativePlatform,home:f.directory,nodePath:process.execPath,baseDirectory:f.base,invocation:{command:process.execPath,args:[]},timeoutMs:1000,spawnImpl:()=>{child=new EventEmitter();queueMicrotask(()=>child.emit('error',new Error('synthetic')));return child;}});
  await assert.rejects(auth.completion,/系统登录终端/);await auth.cleanup();assert.equal(fs.existsSync(auth.directory),false);
});
test('credentials in flags, shell launchers and injected interactive input are refused',t=>{
  const f=fixture(t),options={platform:nativePlatform,home:f.directory,nodePath:process.execPath,baseDirectory:f.base};
  for(const invocation of [{command:process.execPath,args:['--api-key=SYNTHETIC']},{command:process.execPath,args:[],shell:true},{command:process.execPath,args:[],stdin:'credential'}])assert.throws(()=>launchInteractiveAuth({...options,invocation}),/凭据|shell|认证输入/);
});

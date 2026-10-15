'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const Module=require('node:module');

// Real provider logic with synthetic process responses. Every filesystem view
// is restricted to the fixture, so this suite cannot inspect a real login.
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-provider-detection-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'selected-home'),ambient=path.join(root,'ambient-home'),temp=path.join(root,'tmp');
 for(const folder of [home,ambient,temp])fs.mkdirSync(folder,{recursive:true});
 return {root,home,ambient,temp,calls:[],lookups:[],authContentReads:[]};
}
function write(file,value='fixture'){
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o700});return file;
}
function within(root,file){
 if(typeof file!=='string')return false;
 const relative=path.relative(root,path.resolve(file));return !relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
}
function loadProviders(f,{commands={},signedIn=true,externalReady=true}={}){
 const filename=path.resolve(__dirname,'../lib/providers.cjs'),source=fs.readFileSync(filename,'utf8');
 const denied=file=>{const error=new Error('Outside isolated provider fixture');error.code='ENOENT';error.path=String(file);return error;};
 const view={...fs};
 for(const name of ['statSync','lstatSync','readFileSync','readdirSync','realpathSync','accessSync']){
  view[name]=function(file,...args){
   if(!within(f.root,file))throw denied(file);
   if(name==='readFileSync'&&String(file).includes(path.join('Public','auth'))){f.authContentReads.push(String(file));throw new Error('Auth content must not be read');}
   return fs[name](file,...args);
  };
 }
 view.existsSync=file=>within(f.root,file)&&fs.existsSync(file);
 const runtime=require('../lib/runtime.cjs');
 const processBoundary={
  spawn(){throw new Error('No real asynchronous process is allowed in provider detection tests');},
  spawnSync(command,args,options){
   assert(within(f.root,command),'only fixture commands may be inspected');
   const call={command,args:[...args],env:{...options.env}};f.calls.push(call);
   if(path.basename(command)==='DeepSeek Harness'||path.basename(command)==='DeepSeek Harness.exe')return {status:0,stdout:JSON.stringify({variants:[{providerRoute:'workbuddy-ai',label:'WorkBuddy AI',ready:externalReady,authStatus:externalReady?'configured':'required',models:[{id:'fixture-wb-model',label:'Fixture WB',efforts:['default','low'],ready:externalReady,availability:externalReady?'configured-cached':'signed-out'}]}]}),stderr:''};
   if(command===commands.opencode)return {status:0,stdout:args[0]==='auth'?'[]':'fixture/selected-model\n',stderr:''};
   if(args[0]==='login')return {status:signedIn?0:1,stdout:signedIn?'Logged in using ChatGPT':'Not logged in',stderr:''};
   return {status:1,stdout:'',stderr:''};
  },
 };
 const local=new Module(filename,module);local.filename=filename;local.paths=module.paths;
 const ordinaryRequire=local.require.bind(local);
 local.require=function(name){
  if(name==='node:fs')return view;
  if(name==='node:os')return {...os,homedir:()=>f.ambient,tmpdir:()=>f.temp};
  if(name==='node:child_process')return processBoundary;
  if(name==='./google-agents.cjs')return {detectGoogleProviders:()=>[]};
  if(name==='./runtime.cjs')return {...runtime,
   findCLI(name,options){
    f.lookups.push({name,options});
    return [...(options.extra||[]),commands[name]].filter(Boolean).find(file=>within(f.root,file)&&fs.existsSync(file)&&fs.statSync(file).isFile())||null;
   },
   resolveCLIInvocation:({executable,args,env})=>({command:executable,args,env,shell:false}),
  };
  return ordinaryRequire(name);
 };
 local._compile(source,filename);return local.exports;
}
function applications(f,platform='darwin',location='Applications'){
 const dir=path.join(f.home,location,'relocated-agents');
 function app(name){
  const appPath=platform==='darwin'?path.join(dir,name+'.app'):write(path.join(dir,name,name+'.exe'));
  const resources=platform==='darwin'?path.join(appPath,'Contents','Resources'):path.join(path.dirname(appPath),'resources');
  fs.mkdirSync(resources,{recursive:true});return {appPath,resources};
 }
 const codex=app('Codex'),workbuddy=app('WorkBuddy AI'),dsh=app('DeepSeek Harness');
 const codexCLI=write(path.join(codex.resources,'codex'));
 const workbuddyCLI=write(path.join(workbuddy.resources,'app.asar.unpacked','cli','dist','codebuddy-headless.js'));
 const dshCLI=write(path.join(dsh.resources,'runtime','cli','bin','dsh'));
 const host=platform==='darwin'?write(path.join(dsh.appPath,'Contents','MacOS','DeepSeek Harness')):dsh.appPath;
 const wbHost=platform==='darwin'?write(path.join(workbuddy.appPath,'Contents','MacOS','Electron')):workbuddy.appPath;
 write(path.join(dsh.resources,'app.asar'));
 const discovered=[['Codex',codex],['WorkBuddy AI',workbuddy],['DeepSeek Harness',dsh]].map(([name,value],i)=>({id:'app-fixture-'+i,name,appPath:value.appPath,installed:true,ready:false,mode:'handoff'}));
 return {codex,workbuddy,dsh,codexCLI,workbuddyCLI,dshCLI,host,wbHost,discovered};
}
function connector(dshHome){
 const root=path.join(dshHome,'profiles','desktop','node_modules','dsh-workbuddy-connect');
 write(path.join(root,'package.json'),{name:'dsh-workbuddy-connect',version:'0.1.0-fixture'});
 write(path.join(root,'lib','index.js'));return root;
}
function officialCodeBuddy(f){
 const root=path.join(f.root,'sdk','node_modules','@tencent-ai','codebuddy-code');
 const executable=write(path.join(root,'bin','codebuddy'));
 write(path.join(root,'package.json'),{name:'@tencent-ai/codebuddy-code',version:'2.167.0',bin:{codebuddy:'bin/codebuddy'}});
 return {id:'codebuddy',mode:'cli',ready:false,executable,officialPackage:{name:'@tencent-ai/codebuddy-code',version:'2.167.0'},models:[{id:'default',efforts:['default'],ready:false}]};
}
const catalog=id=>({authenticated:true,executionVerified:false,defaultModelId:id,models:[{id,label:id,efforts:['default','low']}]});

test('discovered non-default macOS Codex, WorkBuddy and DSH paths feed the existing adapters without duplicate cards',t=>{
 const f=fixture(t),apps=applications(f);connector(path.join(f.home,'.dsh'));
 const api=loadProviders(f),rows=api.detectProviders({home:f.home,platform:'darwin',env:{PATH:''},nodePath:process.execPath,discoveredProviders:apps.discovered});
 for(const [id,appPath,executable] of [['codex',apps.codex.appPath,apps.codexCLI],['workbuddy',apps.workbuddy.appPath,apps.workbuddyCLI],['dsh',apps.dsh.appPath,apps.dshCLI]]){
  const provider=rows.find(x=>x.id===id);assert.equal(provider.appPath,appPath);assert.equal(provider.executable,executable);assert.equal(provider.installed,true);assert.equal(provider.ready,true,id);
 }
 assert.equal(rows.filter(row=>apps.discovered.some(app=>app.appPath===row.appPath)).length,3);
 const metadata=f.calls.find(call=>call.command===apps.host);assert(metadata);
 assert.equal(metadata.env.HOME,f.home);assert.equal(metadata.env.DSH_HOME,path.join(f.home,'.dsh'));assert.equal(metadata.env.WORKBUDDY_AI_ELECTRON_BIN,apps.wbHost);
 assert(metadata.args.some(value=>value.includes(pathToFileURL(path.join(apps.dsh.resources,'app.asar','dsh','package.json')).href)));assert(f.calls.every(call=>!call.args.includes('session/prompt')));
});

test('discovered Windows WorkBuddy and DSH executables use their own resources and user environment',t=>{
 const f=fixture(t),apps=applications(f,'win32'),dshHome=path.join(f.home,'custom-dsh');connector(dshHome);
 const rows=loadProviders(f).detectProviders({home:f.home,platform:'win32',nodePath:process.execPath,discoveredProviders:apps.discovered,env:{PATH:'',DSH_HOME:dshHome,APPDATA:path.join(f.home,'Roaming'),LOCALAPPDATA:path.join(f.home,'Local')}});
 for(const [id,appPath] of [['workbuddy',apps.workbuddy.appPath],['dsh',apps.dsh.appPath]]){const provider=rows.find(x=>x.id===id);assert.equal(provider.appPath,appPath);assert.equal(provider.ready,true,id);}
 const metadata=f.calls.find(call=>call.command===apps.host);assert(metadata);assert.equal(metadata.env.USERPROFILE,f.home);assert.equal(metadata.env.WORKBUDDY_AI_ELECTRON_BIN,apps.wbHost);assert.equal(metadata.env.DSH_HOME,dshHome);
});

test('downloaded lookalike Codex and DSH applications are displayed but never automatically executed',t=>{
 for(const executionTrust of ['untrusted-discovery','installed-application']){
  const f=fixture(t),apps=applications(f,'darwin','Downloads');connector(path.join(f.home,'.dsh'));
  const discovered=apps.discovered.map(row=>({...row,executionTrust}));
  const rows=loadProviders(f).detectProviders({home:f.home,platform:'darwin',env:{PATH:''},discoveredProviders:discovered});
  assert.equal(f.calls.length,0,'download paths must not reach a status command even with a forged trust flag');
  for(const id of ['codex','workbuddy','dsh'])assert.equal(rows.find(row=>row.id===id).ready,false);
  for(const candidate of discovered){const row=rows.find(row=>row.appPath===candidate.appPath);assert(row,'untrusted discovery should remain visible');assert.equal(row.mode,'handoff');assert.equal(row.ready,false);}
 }
});

test('untrusted discovery origin remains untrusted after its canonical app path leaves Downloads',t=>{
 const f=fixture(t),apps=applications(f,'darwin','Applications');connector(path.join(f.home,'.dsh'));
 // A bundle link in Downloads may resolve outside that folder. Discovery must
 // retain its source trust flag instead of promoting the resolved destination.
 const discovered=apps.discovered.map(row=>({...row,executionTrust:'untrusted-discovery'}));
 const rows=loadProviders(f).detectProviders({home:f.home,platform:'darwin',env:{PATH:''},discoveredProviders:discovered});
 assert.equal(f.calls.length,0);
 for(const candidate of discovered){const row=rows.find(row=>row.appPath===candidate.appPath);assert(row);assert.equal(row.mode,'handoff');assert.equal(row.ready,false);}
});

test('installed application and cached roster alone never become a verified native login',t=>{
 const f=fixture(t),apps=applications(f);connector(path.join(f.home,'.dsh'));
 const rows=loadProviders(f,{signedIn:false,externalReady:false}).detectProviders({home:f.home,platform:'darwin',env:{PATH:''},discoveredProviders:apps.discovered});
 for(const id of ['codex','workbuddy','dsh']){const provider=rows.find(x=>x.id===id);assert.equal(provider.installed,true);assert.equal(provider.ready,false);assert(provider.models.every(row=>!row.ready),id);}
});

test('explicit home, CODEX_HOME, DSH_HOME and OpenCode configuration never borrow the ambient user context',t=>{
 const f=fixture(t),apps=applications(f),codexHome=path.join(f.home,'codex-profile'),dshHome=path.join(f.home,'dsh-profile');connector(dshHome);
 write(path.join(codexHome,'models_cache.json'),{models:[{visibility:'list',slug:'selected-codex-model'}]});
 write(path.join(f.ambient,'.codex','models_cache.json'),{models:[{visibility:'list',slug:'ambient-model-must-not-appear'}]});
 write(path.join(f.home,'Library','Application Support','ai.opencode.desktop','opencode.settings'),{defaultServerUrl:'http://127.0.0.1:38888'});
 const opencode=write(path.join(f.home,'bin','opencode'));
 const xdg=path.join(f.home,'xdg'),environment={HOME:f.ambient,PATH:'',CODEX_HOME:codexHome,DSH_HOME:dshHome,XDG_CONFIG_HOME:xdg,OPENCODE_CONFIG_DIR:path.join(f.home,'opencode-profile'),NODE_OPTIONS:'SYNTHETIC_AMBIENT_INJECTION'};
 const rows=loadProviders(f,{commands:{opencode}}).detectProviders({home:f.home,platform:'darwin',env:environment,nodePath:process.execPath,discoveredProviders:apps.discovered});
 assert(rows.find(x=>x.id==='codex').models.some(row=>row.id==='selected-codex-model'));assert(!JSON.stringify(rows).includes('ambient-model-must-not-appear'));
 const codex=f.calls.find(call=>call.args[0]==='login');assert.equal(codex.env.HOME,f.home);assert.equal(codex.env.CODEX_HOME,codexHome);assert.equal(codex.env.NODE_OPTIONS,undefined);
 const opencodeCalls=f.calls.filter(call=>call.command===opencode);assert.equal(opencodeCalls.length,2);
 for(const call of opencodeCalls){assert.equal(call.env.HOME,f.home);assert.equal(call.env.XDG_CONFIG_HOME,xdg);assert.equal(call.env.OPENCODE_CONFIG_DIR,environment.OPENCODE_CONFIG_DIR);assert(call.args.includes('http://127.0.0.1:38888'));assert.equal(call.env.NODE_OPTIONS,undefined);}
 const metadata=f.calls.find(call=>call.command===apps.host);assert.equal(metadata.env.DSH_HOME,dshHome);assert.equal(metadata.env.HOME,f.home);
});

test('CodeBuddy inspection receives its explicit platform and sanitized account directory environment',async t=>{
 const f=fixture(t),api=loadProviders(f),provider=officialCodeBuddy(f),config=path.join(f.home,'codebuddy-profile');let received;
 const result=await api.enrichCodeBuddyProvider(provider,{home:f.home,platform:'win32',nodePath:process.execPath,environment:{HOME:f.ambient,USERPROFILE:f.ambient,PATH:'fixture-path',CODEBUDDY_CONFIG_DIR:config,CODEBUDDY_AUTH_TOKEN:'SYNTHETIC_MUST_NOT_FORWARD',NODE_OPTIONS:'SYNTHETIC_MUST_NOT_FORWARD'},inspect:async options=>{received=options;assert(within(f.temp,options.cwd));return catalog('fixture-model');}});
 assert.equal(result.ready,true);assert.equal(received.platform,'win32');assert.equal(received.env.HOME,f.home);assert.equal(received.env.USERPROFILE,f.home);assert.equal(received.env.CODEBUDDY_CONFIG_DIR,config);assert.equal(received.env.PATH,'fixture-path');
 assert.equal(received.env.CODEBUDDY_AUTH_TOKEN,undefined);assert.equal(received.env.NODE_OPTIONS,undefined);assert.equal(fs.existsSync(received.cwd),false);assert.equal(f.calls.length,0);
});

test('CodeBuddy cache separates homes, explicit config roots, platforms and native application-support roots',async t=>{
 const f=fixture(t),api=loadProviders(f),provider=officialCodeBuddy(f),other=path.join(f.root,'other-home');fs.mkdirSync(other);
 let calls=0;const inspect=async()=>catalog('context-'+(++calls));
 const context={home:f.home,platform:'darwin',environment:{CODEBUDDY_CONFIG_DIR:path.join(f.home,'profile-a')},inspect};
 const a=await api.enrichCodeBuddyProvider(provider,context),again=await api.enrichCodeBuddyProvider(provider,context);
 assert.equal(calls,1);assert.equal(a.models[1].id,again.models[1].id);
 const contexts=[{...context,home:other},{...context,environment:{CODEBUDDY_CONFIG_DIR:path.join(f.home,'profile-b')}},{...context,platform:'win32',environment:{CODEBUDDY_CONFIG_DIR:path.join(f.home,'profile-a'),LOCALAPPDATA:path.join(f.home,'Local-A')}},{...context,platform:'win32',environment:{CODEBUDDY_CONFIG_DIR:path.join(f.home,'profile-a'),LOCALAPPDATA:path.join(f.home,'Local-B')}}];
 for(const options of contexts){const result=await api.enrichCodeBuddyProvider(provider,options);assert.equal(result.models[1].id,'context-'+calls);}
 assert.equal(calls,5,'each distinct account context must inspect its own native session');
 await api.enrichCodeBuddyProvider(provider,{...context,refresh:true});assert.equal(calls,6);
});

for(const platform of ['darwin','win32'])test('CodeBuddy '+platform+' native auth metadata invalidates cached readiness without reading credential contents',async t=>{
 const f=fixture(t),api=loadProviders(f),provider=officialCodeBuddy(f),local=path.join(f.home,'Local'),roaming=path.join(f.home,'Roaming');
 const support=platform==='win32'?local:path.join(f.home,'Library','Application Support');
 const auth=path.join(support,'CodeBuddyExtension','Data','Public','auth');
 const marker=write(path.join(auth,'coding-copilot.fixture.info'),'SYNTHETIC_AUTH_CONTENT_DO_NOT_READ');
 let calls=0;const options={home:f.home,platform,environment:{LOCALAPPDATA:local,APPDATA:roaming},inspect:async()=>++calls===1?catalog('fixture-model'):{authenticated:false,models:[]}};
 assert.equal((await api.enrichCodeBuddyProvider(provider,options)).ready,true);assert.equal((await api.enrichCodeBuddyProvider(provider,options)).ready,true);assert.equal(calls,1);
 fs.appendFileSync(marker,'changed-signature');assert.equal((await api.enrichCodeBuddyProvider(provider,options)).ready,false);assert.equal(calls,2);
 write(marker+'.logged-out','SYNTHETIC_LOGOUT_MARKER');await api.enrichCodeBuddyProvider(provider,options);assert.equal(calls,3);
 assert.deepEqual(f.authContentReads,[]);
});

test('CodeBuddy credential-file presence, empty catalog or failed inspection cannot make an execution provider ready',async t=>{
 const f=fixture(t),api=loadProviders(f),provider=officialCodeBuddy(f);
 write(path.join(f.home,'Library','Application Support','CodeBuddyExtension','Data','Public','auth','coding-copilot.fixture.info'),'SYNTHETIC_NOT_A_LOGIN');
 for(const inspect of [async()=>({authenticated:false,models:[]}),async()=>({authenticated:true,models:[]}),async()=>{throw new Error('SYNTHETIC_PRIVATE_FAILURE');}]){
  const result=await api.enrichCodeBuddyProvider(provider,{home:f.home,platform:'darwin',environment:{},refresh:true,inspect});
  assert.equal(result.ready,false);assert(result.models.every(row=>!row.ready));assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE_FAILURE|SYNTHETIC_NOT_A_LOGIN/);
 }
 assert.deepEqual(f.authContentReads,[]);assert.equal(f.calls.length,0);
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const {ApiRegistry}=require('../lib/api-providers.cjs');
const {EventEmitter}=require('node:events');

function fixture(t,{spawnImpl,setTimeoutImpl,codebuddyAuth,providerModule,platform='darwin'}={}){
  const parent=path.resolve(__dirname,'../work/main-integration');fs.mkdirSync(parent,{recursive:true});
  const root=fs.realpathSync(fs.mkdtempSync(path.join(parent,'case-')));t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  const mainFile=path.resolve(__dirname,'../main.cjs');const actualRequire=createRequire(mainFile);const handlers=new Map();
  const frame={url:pathToFileURL(path.resolve(__dirname,'../ui/index.html')).href};const contents={id:81,mainFrame:frame};
  const opened=[];let chosen;
  const electron={app:{setName(){},requestSingleInstanceLock:()=>true,on(){},whenReady:()=>({then:()=>({catch(){}})})},
    BrowserWindow:class{},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[chosen]})},
    shell:{openPath:async file=>{opened.push(file);return '';}},clipboard:{writeText:text=>{context.clipboardText=text;}},nativeTheme:{},safeStorage:{}};
  const context={require:name=>name==='electron'?electron:name==='./lib/providers.cjs'&&providerModule?providerModule:name==='node:child_process'&&spawnImpl?{spawn:spawnImpl}:name==='./lib/codebuddy-auth.cjs'&&codebuddyAuth?{authenticateCodeBuddy:codebuddyAuth}:actualRequire(name),__dirname:path.dirname(mainFile),module:{exports:{}},
    process:{env:{},resourcesPath:path.dirname(mainFile),platform,argv:[process.execPath],execPath:process.execPath},Buffer,AbortController,setTimeout:setTimeoutImpl||setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(mainFile,'utf8')+'\n;globalThis.testBoundary={set(e,r){engine=e;apiRegistry=r;win={webContents:{id:81,mainFrame:null}};},setConversations(s){conversationStore=s;},setWindow(w){win=w;},registerIPC,permittedWorkspace,detectProviders,runAgentProvider,waitForWindowIdle};',context,{filename:mainFile});
  const managedRoot=path.join(root,'data','workspaces');fs.mkdirSync(managedRoot,{recursive:true});
  const engine={runs:[],managedRoot,providers:[],refreshes:0,async refreshProviders(){this.refreshes++;this.providers=registry.getProviders();return this.getState();},getState(){return {providers:this.providers};},getRun(id){const run=this.runs.find(row=>row.id===id);if(!run)throw new Error('任务不存在');return run;},saveConfig:config=>config,proposeWorkflow:config=>config,confirmWorkflow:value=>value};
  let registry={getProviders:()=>[]};
  function setRegistry(value){registry=value;context.testBoundary.set(engine,registry);context.testBoundary.setWindow({webContents:contents});}
  setRegistry(registry);context.testBoundary.registerIPC();
  const invoke=(name,...args)=>handlers.get('agentflow:'+name)({sender:contents,senderFrame:frame},...args);
  return {root,engine,contents,frame,opened,invoke,setRegistry,setChosen:value=>{chosen=value;},context};
}

test('API 目录或探针失败后立即撤销推荐目录中陈旧的 ready 状态',async t=>{
  const f=fixture(t);let ready=true;
  f.setRegistry({getProviders:()=>[{id:'api-test',mode:'api',ready}],refreshModels:async()=>{ready=false;throw new Error('API 返回 HTTP 401。');},probeProvider:async()=>{ready=false;throw new Error('API 返回 HTTP 403。');}});
  f.engine.providers=[{id:'api-test',mode:'api',ready:true}];
  await assert.rejects(f.invoke('refreshApiModels','api-test'),/401/);assert.equal(f.engine.providers[0].ready,false);assert.equal(f.engine.refreshes,1);
  ready=true;f.engine.providers=[{id:'api-test',mode:'api',ready:true}];
  await assert.rejects(f.invoke('testProvider','api-test'),/403/);assert.equal(f.engine.providers[0].ready,false);assert.equal(f.engine.refreshes,2);
});

test('API IPC 保存只返回白名单 metadata，不发起自动推理或泄露密钥',async t=>{
  const f=fixture(t);let requests=0;
  const vault={isAvailable:()=>true,encrypt:value=>Buffer.from([...value].reverse().join('')),decrypt:buffer=>[...buffer.toString()].reverse().join('')};
  const registry=new ApiRegistry({dataDir:path.join(f.root,'api'),vault,fetchImpl:async()=>{requests++;throw new Error('should not run');}});await registry.init();f.setRegistry(registry);
  const saved=await f.invoke('saveApiProvider',{name:'私有 API',baseUrl:'https://example.test/v1',protocol:'openai',apiKey:'synthetic-secret-7de3',models:[{id:'custom'}]});
  assert.equal(requests,0);assert.equal(saved.ready,false);assert.equal(saved.hasKey,true);
  const serialized=JSON.stringify(await f.invoke('getState'));assert(!serialized.includes('synthetic-secret-7de3'));assert(!serialized.includes('ciphertext'));assert(!serialized.includes('apiKey'));
  if(process.platform!=='win32')assert.equal(fs.statSync(path.join(f.root,'api','api-providers.json')).mode&0o777,0o600);
  const badVault=new ApiRegistry({dataDir:path.join(f.root,'bad-api'),vault:{isAvailable:()=>true,encrypt:()=>{throw new Error('synthetic-secret-7de3');}}});await badVault.init();f.setRegistry(badVault);
  await assert.rejects(f.invoke('saveApiProvider',{name:'x',baseUrl:'https://example.test/v1',protocol:'openai',apiKey:'synthetic-secret-7de3'}),error=>!error.message.includes('synthetic-secret')&&/安全存储/.test(error.message));
});

test('托管任务目录可以打开保存继续，未授权路径及被替换目录均被拒绝',async t=>{
  const f=fixture(t);const id='01234567-89ab-4cde-8fab-0123456789ab';const managed=path.join(f.engine.managedRoot,id);fs.mkdirSync(managed);f.engine.runs=[{id,workspace:managed}];
  assert.equal(await f.invoke('openWorkspace',managed),true);assert.equal(f.opened[0],managed);
  assert.equal((await f.invoke('saveConfig',{workspace:managed})).workspace,managed);
  assert.equal((await f.invoke('proposeWorkflow',{workspace:managed})).workspace,managed);
  const outside=path.join(f.root,'not-selected');fs.mkdirSync(outside);
  await assert.rejects(f.invoke('openWorkspace',outside),/先选择/);
  f.setChosen(outside);assert.equal(await f.invoke('chooseWorkspace'),outside);assert.equal(await f.invoke('openWorkspace',outside),true);
  const original=managed+'-original';fs.renameSync(managed,original);fs.symlinkSync(outside,managed,process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.invoke('openWorkspace',managed),/被替换|符号链接/);
  await assert.rejects(f.invoke('saveConfig',{workspace:managed}),/被替换|符号链接/);
});

test('所有新 API 和任务入口保持主窗口及主框架 IPC 来源检查',async t=>{
  const f=fixture(t);
  for(const name of ['saveApiProvider','removeApiProvider','refreshApiModels','testProvider','proposeWorkflow','confirmWorkflow','confirmResult','authenticateProvider','cancelAuthentication','getConversation']){
    const handler=f.context.testBoundary;
    assert(handler);
    // An origin change must reject before any downstream operation is reached.
    const old=f.frame.url;f.frame.url='https://untrusted.invalid/';
    await assert.rejects(f.invoke(name,{apiKey:'synthetic'}),/拒绝非工作台/);f.frame.url=old;
  }
});

test('逐环节对话IPC返回全部真实attempt记录，保留完整存储输出并明确标记旧历史输入缺失',async t=>{
 const f=fixture(t),runId='01234567-89ab-4cde-8fab-0123456789ab',first='11234567-89ab-4cde-8fab-0123456789ab',second='21234567-89ab-4cde-8fab-0123456789ab';
 f.engine.runs=[{id:runId,stages:[{id:'execute',provider:'dsh',model:'chosen',effort:'low',status:'running',text:'short tail',attempts:[{id:first,status:'failed',text:'legacy reply'},{id:second,status:'running'}]}]}];
 const full={runId,stageId:'execute',attemptId:second,input:'actual prompt',inputCaptured:true,output:'complete output before short tail',messages:[{id:'m1',role:'assistant',text:'public process'}],usage:{input:4,output:2}};
 f.context.testBoundary.setConversations({get:ids=>ids.attemptId===second?full:null});
 const result=await f.invoke('getConversation',{runId,stageId:'execute'});assert.equal(result.selectedAttemptId,second);assert.equal(result.attempts.length,2);
 assert.equal(result.attempts[0].input,null);assert.equal(result.attempts[0].inputCaptured,false);assert.equal(result.attempts[0].legacy,true);assert.equal(result.attempts[0].output,'legacy reply');
 assert.equal(result.attempts[1].output,full.output);assert.equal(result.attempts[1].input,'actual prompt');assert.equal(result.attempts[1].messages[0].text,'public process');
 await assert.rejects(f.invoke('getConversation',{runId,stageId:'missing'}),/环节不存在/);await assert.rejects(f.invoke('getConversation',{runId,stageId:'execute',attemptId:'bad'}),/记录不存在/);
});

test('全文复制只通过已知记录ID读取主进程存储，不提升全局IPC负载上限',async t=>{
 const f=fixture(t),runId='01234567-89ab-4cde-8fab-0123456789ab',attemptId='11234567-89ab-4cde-8fab-0123456789ab';
 f.engine.runs=[{id:runId,stages:[{id:'execute',attempts:[{id:attemptId}]}]}];const output='长'.repeat(300000);
 f.context.testBoundary.setConversations({get:()=>({runId,stageId:'execute',attemptId,input:'actual input',inputCaptured:true,output,messages:[{id:'public-1',text:'public reply'}]})});
 assert.equal(await f.invoke('copyConversation',{runId,stageId:'execute',attemptId,field:'output'}),true);assert.equal(f.context.clipboardText,output);
 await f.invoke('copyConversation',{runId,stageId:'execute',attemptId,field:'message',messageId:'public-1'});assert.equal(f.context.clipboardText,'public reply');
 await assert.rejects(f.invoke('copyConversation',{runId,stageId:'execute',attemptId,field:'message',messageId:'missing'}),/不存在/);
 await assert.rejects(f.invoke('copyConversation',{runId,stageId:'execute',attemptId:'bad',field:'output'}),/不存在/);
});


test('正式 API 执行鉴权失败后立即同步到引擎目录',async t=>{
  const f=fixture(t);let ready=true;
  f.setRegistry({getProviders:()=>[{id:'api-test',mode:'api',ready}],runProvider:async()=>{ready=false;throw new Error('API 返回 HTTP 401。');}});
  f.engine.providers=[{id:'api-test',mode:'api',ready:true}];
  await assert.rejects(f.context.testBoundary.runAgentProvider({provider:f.engine.providers[0]}),/401/);
  assert.equal(f.engine.providers[0].ready,false);assert.equal(f.engine.refreshes,1);
});

test('API probe success exposes the same explicit ok contract expected by the renderer',async t=>{
  const f=fixture(t);const metadata={id:'api-test',mode:'api',ready:true,hasKey:true,models:[{id:'model',ready:true}]};
  f.setRegistry({getProviders:()=>[metadata],probeProvider:async()=>metadata});
  f.engine.providers=[{id:'api-test',mode:'api',ready:false}];
  const result=await f.invoke('testProvider','api-test');
  assert.equal(result.ok,true);assert.equal(result.provider.id,'api-test');assert.equal(result.provider.ready,true);assert.equal(f.engine.refreshes,1);
});

test('官方登录以固定命令无 shell 启动，重复点击复用流程且运行中的启动模型禁止重登',async t=>{
  const calls=[];const children=[];
  const f=fixture(t,{spawnImpl:(command,args,options)=>{const child=new EventEmitter();child.pid=991231;calls.push({command,args,options});children.push(child);queueMicrotask(()=>child.emit('spawn'));return child;}});
  const provider={id:'codex',mode:'cli',executable:'/Applications/Codex.app/Contents/Resources/codex',ready:true};f.setRegistry({getProviders:()=>[provider]});f.engine.providers=[provider];
  const first=await f.invoke('authenticateProvider','codex');assert.equal(first.started,true);assert.equal(first.kind,'browser-cli');
  assert.equal((await f.invoke('authenticateProvider','codex')).pending,true);assert.equal(calls.length,1);
  assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.stdio,'ignore');assert.deepEqual(Array.from(calls[0].args),['login']);
  children[0].emit('close',0);
  f.engine.providers=[{id:'codex',mode:'cli',executable:'/Applications/Codex.app/Contents/Resources/codex',ready:true}];
  f.engine.runs=[{starter:{provider:'codex',status:'running'},stages:[]}];
  await assert.rejects(f.invoke('authenticateProvider','codex'),/正在执行/);assert.equal(calls.length,1);
});

test('桌面登录仅打开原应用，启动失败返回短错误且能再次尝试',async t=>{
  let failed=true;const calls=[];
  const f=fixture(t,{spawnImpl:(command,args,options)=>{const child=new EventEmitter();calls.push({command,args,options});queueMicrotask(()=>{if(failed)child.emit('error',new Error('do-not-expose-vendor-details'));else{child.emit('spawn');setImmediate(()=>child.emit('close',0));}});return child;}});
  const provider={id:'doubao',name:'豆包',installed:true,mode:'handoff',ready:false,appPath:'/Applications/Doubao.app'};
  f.engine.providers=[provider];await assert.rejects(f.invoke('authenticateProvider','doubao'),error=>/未能启动/.test(error.message)&&!error.message.includes('vendor-details'));
  failed=false;f.engine.providers=[provider];const result=await f.invoke('authenticateProvider','doubao');assert.equal(result.started,true);assert.equal(result.kind,'desktop');
  assert.equal(calls[1].command,'/usr/bin/open');assert.deepEqual(Array.from(calls[1].args),['-a',provider.appPath]);assert.equal(provider.ready,false);
});

test('迅速完成的网页登录不遗留超时回调，避免之后向已回收PID发信号',async t=>{
  let timers=0;
  const f=fixture(t,{setTimeoutImpl:(...args)=>{timers++;return setTimeout(...args);},spawnImpl:()=>{const child=new EventEmitter();child.pid=991231;queueMicrotask(()=>{child.emit('spawn');child.emit('close',0);});return child;}});
  const provider={id:'codex',mode:'cli',executable:'/Applications/Codex.app/Contents/Resources/codex',ready:true};f.setRegistry({getProviders:()=>[provider]});f.engine.providers=[provider];
  assert.equal((await f.invoke('authenticateProvider','codex')).started,true);assert.equal(timers,0);
});

test('CodeBuddy 区域只允许公开白名单，官方网页登录开始后立即返回且重复点击不新开授权',async t=>{
  const calls=[];let finish;
  const f=fixture(t,{codebuddyAuth:options=>{calls.push(options);options.onStarted();return new Promise(resolve=>{finish=resolve;});}});
  const provider={id:'codebuddy',mode:'cli',installed:true,ready:false,executable:'/Users/test/official-package/bin/codebuddy',models:[{id:'default',ready:false}]};
  f.setRegistry({getProviders:()=>[provider]});f.engine.providers=[provider];
  await assert.rejects(f.invoke('authenticateProvider','codebuddy','custom-endpoint'),/微信登录或国际/);assert.equal(calls.length,0);
  const result=await f.invoke('authenticateProvider','codebuddy','internal');assert.equal(result.started,true);assert.equal(result.kind,'browser-cli');assert.equal(calls[0].methodId,'internal');
  assert.equal((await f.invoke('authenticateProvider','codebuddy','external')).pending,true);assert.equal(calls.length,1);
  assert.equal(Object.hasOwn(result,'token'),false);assert.equal(calls[0].signal.aborted,false);assert.equal(fs.existsSync(calls[0].cwd),true);
  finish({authenticated:true,methodId:'internal'});await new Promise(resolve=>setImmediate(resolve));assert.equal(fs.existsSync(calls[0].cwd),false);
});

test('取消网页登录中止当前认证、清理私有目录并允许立即重试',async t=>{
  const calls=[];let finish;
  const f=fixture(t,{codebuddyAuth:options=>{calls.push(options);options.onStarted();return new Promise((resolve,reject)=>{finish=resolve;options.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});}});
  const provider={id:'codebuddy',mode:'cli',installed:true,ready:false,executable:'/Users/test/official-package/bin/codebuddy',models:[{id:'default',ready:false}]};f.setRegistry({getProviders:()=>[provider]});f.engine.providers=[provider];
  await f.invoke('authenticateProvider','codebuddy','internal');assert.equal((await f.invoke('cancelAuthentication','codebuddy')).cancelled,true);assert.equal(calls[0].signal.aborted,true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(fs.existsSync(calls[0].cwd),false);
  assert.equal((await f.invoke('authenticateProvider','codebuddy','internal')).pending,undefined);assert.equal(calls.length,2);
  finish({authenticated:true,methodId:'internal'});await new Promise(resolve=>setImmediate(resolve));
});

test('CLI connection verification returns its actual tested model and effort, not an untested default alias',async t=>{
 const f=fixture(t,{providerModule:{probeProvider:async()=>({verifiedModelId:'fast',verifiedRequestModelId:'hy3',verifiedEffort:'low',usage:{input:1,output:1}})}});
 const provider={id:'codebuddy',mode:'cli',ready:true,executable:'/test/official/codebuddy',models:[{id:'default'},{id:'fast'}]};
 f.setRegistry({getProviders:()=>[provider]});f.engine.providers=[provider];
 const result=await f.invoke('testProvider','codebuddy');assert.equal(result.ok,true);assert.equal(result.modelId,'hy3');assert.equal(result.effort,'low');
});


test('Windows desktop entry opens the known app without tracking or killing its process',async t=>{
  const f=fixture(t,{platform:'win32',spawnImpl:()=>{throw new Error('must not spawn app for login');}});
  const executable=path.join(f.root,'Example.exe');fs.writeFileSync(executable,'synthetic desktop');
  const provider={id:'doubao',name:'豆包',installed:true,mode:'handoff',ready:false,appPath:executable};f.engine.providers=[provider];
  const result=await f.invoke('authenticateProvider','doubao');assert.equal(result.kind,'desktop');assert.equal(result.started,true);assert.equal(f.opened[0],executable);
  assert.equal((await f.invoke('cancelAuthentication','doubao')).cancelled,false);assert.equal(provider.ready,false);
});


test('Packaged startup waits for the real stop-loading event after the document finishes',async t=>{
  const f=fixture(t),contents=new EventEmitter();let loading=true,finished=false;contents.isLoading=()=>loading;
  const pending=f.context.testBoundary.waitForWindowIdle(contents).then(()=>{finished=true;});
  contents.emit('did-finish-load');await Promise.resolve();assert.equal(finished,false);
  loading=false;contents.emit('did-stop-loading');await pending;assert.equal(finished,true);assert.equal(contents.listenerCount('did-stop-loading'),0);
  await f.context.testBoundary.waitForWindowIdle(contents);assert.equal(contents.listenerCount('did-stop-loading'),0);
});

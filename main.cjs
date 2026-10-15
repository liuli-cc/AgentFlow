'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell,clipboard,nativeTheme,safeStorage}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {Worker}=require('node:worker_threads');
const {Engine,validateWorkspace,aggregateUsage,redact}=require('./lib/engine.cjs');
const providersModule=require('./lib/providers.cjs');
const {Telemetry}=require('./lib/telemetry.cjs');
const {ApiRegistry}=require('./lib/api-providers.cjs');
const {discoverApplications,DiscoveryWatcher}=require('./lib/discovery.cjs');
const {describeAuth,createAuthInvocation}=require('./lib/auth.cjs');
const {authenticateCodeBuddy}=require('./lib/codebuddy-auth.cjs');
const {ConversationStore}=require('./lib/conversations.cjs');
const {readOfficialConversation}=require('./lib/session-conversations.cjs');
const {resolveCLIInvocation,terminateProcessTree,findCLI}=require('./lib/runtime.cjs');
const {handleInstallerEvent}=require('./lib/install-events.cjs');

app.setName('AgentFlow');
const installerEvent=handleInstallerEvent({app,platform:process.platform,argv:process.argv,execPath:process.execPath});
const smokeTest=process.env.AGENTFLOW_SMOKE_TEST==='1';
if(smokeTest){
  const requested=process.env.AGENTFLOW_DATA_DIR;
  if(!requested||!path.isAbsolute(requested))throw new Error('启动验收必须使用独立临时目录');
  const relative=path.relative(fs.realpathSync(os.tmpdir()),fs.realpathSync(requested));
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('启动验收目录必须位于系统临时目录中');
}
if((!app.isPackaged||smokeTest)&&process.env.AGENTFLOW_DATA_DIR)app.setPath('userData',path.resolve(process.env.AGENTFLOW_DATA_DIR));
const single=!installerEvent&&app.requestSingleInstanceLock();
if(!single&&!installerEvent){app.quit();}
let win,engine,telemetry,apiRegistry,discoveryWatcher,conversationStore,startupPromise,windowLoadPromise,quitting=false,initializing=true;
const approvedWorkspaces=new Set();
const verifiedProviders=new Map();
const authenticationProcesses=new Map();
const authenticationMessages=new Map();
const nodeCandidates=[
  path.join(process.resourcesPath,process.platform==='win32'?'node.exe':'node'),
  ...(process.platform==='win32'?[process.env.ProgramFiles&&path.join(process.env.ProgramFiles,'nodejs','node.exe'),process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Programs','nodejs','node.exe')].filter(Boolean):[]),
  '/opt/homebrew/bin/node','/opt/homebrew/opt/node@22/bin/node','/usr/local/bin/node',
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/node',
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/node',
];
function nodePath(){return nodeCandidates.find(p=>{try{fs.accessSync(p,fs.constants.X_OK);return fs.statSync(p).isFile();}catch{return false;}})||findCLI('node')||process.execPath;}
async function detectProviders(){
  if(smokeTest)return [];
  const codebuddyCLIPath=path.join(app.getPath('userData'),'runtimes/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy');
  // Several official CLIs expose status through synchronous commands. Keep those
  // commands off Electron's UI thread so opening/activating the window stays fast.
  const known=await new Promise((resolve,reject)=>{
    const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const p=require(workerData.modulePath);const known=await p.detectProviders(workerData.options);const i=known.findIndex(x=>x.id==='codebuddy');if(i>=0&&p.enrichCodeBuddyProvider)known[i]=await p.enrichCodeBuddyProvider(known[i],{nodePath:workerData.options.nodePath,refresh:workerData.refresh});parentPort.postMessage({known});})().catch(()=>parentPort.postMessage({failed:true}));`,
      {eval:true,workerData:{modulePath:path.join(__dirname,'lib/providers.cjs'),options:{nodePath:nodePath(),codebuddyCLIPath},refresh:authenticationProcesses.has('codebuddy')}});
    let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('本机智能体检测超时，请重新检测')),60000);timer.unref?.();
    worker.once('message',result=>Array.isArray(result?.known)?finish(null,result.known):finish(new Error('本机智能体检测暂不可用')));
    worker.once('error',()=>finish(new Error('本机智能体检测暂不可用')));worker.once('exit',code=>{if(!settled)finish(new Error('本机智能体检测已停止'));});
  });
  const local=known.map(provider=>{
    const verified=verifiedProviders.get(provider.id);
    return providersModule.applyProviderVerification?providersModule.applyProviderVerification(provider,verified):provider;
  });
  return [...local,...discoverApplications({knownProviders:local}),...(apiRegistry?.getProviders()??[])].map(provider=>{
    const auth=describeAuth(provider,{platform:process.platform});
    if(authenticationProcesses.has(provider.id))auth.state='pending';
    else if(auth.executionReady)authenticationMessages.delete(provider.id);
    const message=authenticationMessages.get(provider.id);
    return {...provider,auth,...(message?{message}: {})};
  });
}
async function runAgentProvider(args){
  if(args.provider.mode!=='api'){
    const startedAt=new Date().toISOString(),result=await providersModule.runProvider({...args,nodePath:nodePath()});
    if(!result.modelId&&result.sessionId&&args.provider.id==='codex'){
      const official=readOfficialConversation({providerId:'codex',sessionId:result.sessionId,workspace:args.workspace,startedAt,finishedAt:new Date().toISOString(),expectedPrompt:args.prompt});
      if(official?.actualModelId)result.modelId=official.actualModelId;
    }
    return result;
  }
  try{return await apiRegistry.runProvider(args);}finally{await engine.refreshProviders();}
}
const uiFile=path.join(__dirname,'ui','index.html');
const uiURL=pathToFileURL(uiFile).href;
function assertSender(event){
  if(!win||event.sender.id!==win.webContents.id||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==uiURL)throw new Error('拒绝非工作台页面的请求');
}
function handle(name,fn){ipcMain.handle('agentflow:'+name,async(event,...args)=>{
  assertSender(event);
  if(Buffer.byteLength(JSON.stringify(args))>600000)throw new Error('请求内容过长');
  try{if(name!=='getState'&&startupPromise)await startupPromise;return await fn(...args);}catch(error){throw new Error(redact(error?.message||String(error)));}
});}
function permittedWorkspace(raw){
  const known=engine?.runs.find(r=>r.workspace===raw);
  const canonical=validateWorkspace(raw,known?{managedRoot:engine.managedRoot}:{});
  if(known&&canonical!==raw)throw new Error('工作目录已被替换，请重新选择');
  if(!known&&!approvedWorkspaces.has(canonical))throw new Error('请先选择任务文件夹');return canonical;
}
function sendState(){if(engine&&win&&!win.isDestroyed()&&!win.webContents.isLoading())win.webContents.send('agentflow:state',engine.getState());}
function providerById(id){if(typeof id!=='string')throw new Error('智能体标识不正确');const p=engine.providers.find(p=>p.id===id);if(!p)throw new Error('智能体不存在');return p;}
async function openProvider(id){
  const p=providerById(id);if(!p.installed||!p.appPath||!fs.existsSync(p.appPath))throw new Error('未安装这个智能体的桌面应用');
  if(process.platform==='darwin')await new Promise((resolve,reject)=>{const c=spawn('/usr/bin/open',['-a',p.appPath],{shell:false,stdio:'ignore'});c.on('error',reject);c.on('exit',code=>code===0?resolve():reject(new Error('原应用未能打开')));});
  else{const error=await shell.openPath(p.appPath);if(error)throw new Error('原应用未能打开');}
  return true;
}
async function startCodeBuddyLogin(provider,methodId){
  if(!['internal','external'].includes(methodId))throw new Error('请选择微信登录或国际账号登录');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-login-'));fs.chmodSync(directory,0o700);
  const controller=new AbortController(),entry={controller,finished:false};
  authenticationProcesses.set(provider.id,entry);authenticationMessages.delete(provider.id);
  return new Promise((resolve,reject)=>{
    let started=false;
    authenticateCodeBuddy({cliPath:provider.executable,nodePath:nodePath(),cwd:directory,methodId,signal:controller.signal,
      onStarted:()=>{started=true;void engine.refreshProviders().catch(()=>{});resolve({started:true,kind:'browser-cli'});},
    }).then(()=>{verifiedProviders.delete(provider.id);authenticationMessages.delete(provider.id);if(!started)resolve({started:true,kind:'browser-cli'});},()=>{
      if(!entry.cancelled)authenticationMessages.set(provider.id,'CodeBuddy 登录未完成，请重试');if(!started)reject(new Error(entry.cancelled?'登录已取消':'CodeBuddy 登录未能启动，请重试'));
    }).finally(()=>{entry.finished=true;if(authenticationProcesses.get(provider.id)===entry)authenticationProcesses.delete(provider.id);fs.rmSync(directory,{recursive:true,force:true});void engine.refreshProviders().catch(()=>{});});
  });
}
async function authenticateProvider(id,methodId){
  const provider=providerById(id),auth=describeAuth(provider,{platform:process.platform});
  if(engine.runs.some(run=>[run.starter,...(run.stages||[])].some(stage=>stage?.provider===id&&stage.status==='running')))throw new Error('该智能体正在执行，请结束当前调用后再登录');
  if(authenticationProcesses.has(id))return {started:true,kind:auth.kind,pending:true};
  if(id==='codebuddy'&&auth.kind==='browser-cli')return startCodeBuddyLogin(provider,methodId);
  if(methodId!==undefined)throw new Error('此智能体不支持选择登录区域');
  if(auth.kind==='desktop'&&process.platform!=='darwin'){
    await openProvider(id);return {started:true,kind:'desktop'};
  }
  const invocation=createAuthInvocation(provider,{nodePath:nodePath(),platform:process.platform});
  authenticationMessages.delete(id);
  const resolved=resolveCLIInvocation({executable:invocation.command,args:invocation.args,nodePath:nodePath(),env:invocation.env,platform:process.platform});
  const child=spawn(resolved.command,resolved.args,{shell:false,detached:process.platform!=='win32',windowsHide:true,stdio:'ignore',env:resolved.env});
  const entry={child,timer:null,finished:false};authenticationProcesses.set(id,entry);
  const clear=()=>{entry.finished=true;if(authenticationProcesses.get(id)===entry)authenticationProcesses.delete(id);clearTimeout(entry.timer);};
  const refresh=()=>engine.refreshProviders().catch(()=>{});
  child.once('error',()=>{if(entry.finished)return;clear();authenticationMessages.set(id,'登录入口未能启动，请重新检测后重试');void refresh();});
  child.once('close',code=>{if(entry.finished)return;clear();if(code!==0)authenticationMessages.set(id,'登录尚未完成，请重新授权');void refresh();});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('登录入口未能启动，请重新检测后重试')));});
  if(auth.kind==='browser-cli'&&!entry.finished&&authenticationProcesses.get(id)===entry){
    entry.timer=setTimeout(()=>{if(entry.finished||authenticationProcesses.get(id)!==entry)return;clear();authenticationMessages.set(id,'登录已超时，请重新授权');void terminateProcessTree(child,{force:process.platform==='win32'});void refresh();},5*60*1000);entry.timer.unref?.();
  }
  void refresh();
  return {started:true,kind:auth.kind};
}
function markdownReport(run){
  const allStages=[...(run.starter?[run.starter]:[]),...run.stages];
  const totals=aggregateUsage(allStages.map(s=>s.usage));
  const show=v=>v==null?'未提供':String(v);
  const conversations=allStages.filter(stage=>(stage.attempts||[]).length).map(stage=>{
    const records=getConversation({runId:run.id,stageId:stage.id}).attempts;
    return records.map((record,index)=>`### ${stage.name} · 第 ${index+1} 次\n\n模型：${record.actualModelId||record.modelId||'未记录'}；思考：${record.effort||'default'}；状态：${record.status||'未知'}\n\n#### 实际输入\n\n${record.inputCaptured?record.input:'此历史任务未记录实际输入，无法还原。'}\n\n#### 公开回复\n\n${record.messages?.length?record.messages.map(message=>message.text).join('\n\n'):record.output||'尚无回复'}${record.truncated?'\n\n记录达到大小上限，内容已截断。':''}\n`).join('\n');
  }).join('\n');
  return redact(`# AgentFlow 任务交付\n\n${run.finalText||'任务尚未通过最终验收。'}\n\n- 状态：${run.status}\n- 开始时间：${run.createdAt}\n- 工作目录：${run.workspace}\n- 任务编号：${run.id}\n\n## 原始需求\n\n${run.prompt}\n\n## 本任务用量\n\n输入：${show(totals.input)}；输出：${show(totals.output)}；缓存读取：${show(totals.cacheRead)}；缓存写入：${show(totals.cacheWrite)}。${totals.partial?'部分智能体未提供指标，以上为已提供部分的合计。':''}\n\n${allStages.map(s=>`## ${s.name} · ${s.provider}\n\n模型：${s.model||'工具默认'}；思考：${s.effort}；状态：${s.status}\n\n${s.text||s.error||'尚未执行'}\n`).join('\n')}\n## 逐环节对话\n\n${conversations||'此任务尚无对话记录。'}\n\n## 事件记录\n\n${run.events.map(e=>`- ${e.time} · ${e.message.replaceAll('\n',' ')}`).join('\n')}\n`);
}
function getConversation({runId,stageId,attemptId}={}){
  const run=engine.getRun(runId),stage=[...(run.starter?[run.starter]:[]),...run.stages].find(row=>row.id===stageId);
  if(!stage)throw new Error('环节不存在');const known=stage.attempts||[];
  if(attemptId!==undefined&&!known.some(row=>row.id===attemptId))throw new Error('对话记录不存在');
  const attempts=known.map((attempt,index)=>{
    const saved=conversationStore?.get({runId,stageId,attemptId:attempt.id});
    if(saved)return saved;
    return {runId,stageId,attemptId:attempt.id,input:null,inputCaptured:false,legacy:true,
      output:redact(attempt.text||(index===known.length-1?stage.text:'')||''),messages:[],activities:[],providerId:stage.provider,
      modelId:stage.model||null,actualModelId:attempt.actualModelId||null,effort:stage.effort||'default',sessionId:attempt.sessionId||null,
      origin:'legacy',usage:attempt.usage,status:attempt.status,startedAt:attempt.startedAt,finishedAt:attempt.finishedAt||null};
  });
  return {runId,stageId,selectedAttemptId:attemptId||known.at(-1)?.id||null,attempts};
}
function registerIPC(){
  handle('getState',()=>({...engine.getState(),initializing}));
  handle('getConversation',getConversation);
  handle('copyConversation',values=>{
    if(!values||!['input','output','message'].includes(values.field))throw new Error('复制内容不正确');
    const result=getConversation(values),record=result.attempts.find(row=>row.attemptId===result.selectedAttemptId);if(!record)throw new Error('对话记录不存在');
    let value;if(values.field==='input'){if(!record.inputCaptured)throw new Error('此历史任务未记录实际输入');value=record.input;}
    else if(values.field==='output')value=record.output;
    else{if(typeof values.messageId!=='string'||values.messageId.length>200)throw new Error('回复标识不正确');value=record.messages?.find(row=>row.id===values.messageId)?.text;}
    if(typeof value!=='string')throw new Error('复制内容不存在');clipboard.writeText(value);return true;
  });
  handle('chooseWorkspace',async()=>{
    const result=await dialog.showOpenDialog(win,{title:'选择智能体可以工作的项目文件夹',properties:['openDirectory','createDirectory'],buttonLabel:'使用此文件夹'});
    if(result.canceled)return null;const chosen=validateWorkspace(result.filePaths[0]);approvedWorkspaces.add(chosen);return chosen;
  });
  handle('saveConfig',config=>{
    if(config?.workspace)permittedWorkspace(config.workspace);return engine.saveConfig(config);
  });
  const propose=config=>{if(config?.workspace)permittedWorkspace(config.workspace);return engine.proposeWorkflow(config);};
  handle('startRun',propose);
  handle('proposeWorkflow',propose);
  handle('confirmWorkflow',values=>{if(values?.workspace)permittedWorkspace(values.workspace);return engine.confirmWorkflow(values);});
  handle('confirmResult',values=>engine.confirmResult(values));
  handle('controlRun',values=>engine.controlRun(values));
  handle('updateStage',values=>engine.updateStage(values));
  handle('getRun',id=>engine.getRun(id));
  handle('deleteThread',values=>engine.deleteThread(values,file=>shell.trashItem(file)));
  handle('refreshProviders',()=>engine.refreshProviders());
  handle('saveApiProvider',async values=>{const provider=await apiRegistry.saveProvider(values);await engine.refreshProviders();return provider;});
  handle('removeApiProvider',async id=>{
    await apiRegistry.removeProvider(id);await engine.refreshProviders();
    if(engine.config?.starter?.provider===id){
      const next=engine.providers.find(p=>p.ready&&['cli','api'].includes(p.mode));
      if(next)engine.saveConfig({...engine.config,starter:{provider:next.id,model:'',effort:'default'}});
    }
    return true;
  });
  handle('refreshApiModels',async id=>{try{return await apiRegistry.refreshModels(id);}finally{await engine.refreshProviders();}});
  handle('authenticateProvider',authenticateProvider);
  handle('cancelAuthentication',async id=>{
    providerById(id);const entry=authenticationProcesses.get(id);if(!entry)return {cancelled:false};
    entry.finished=true;entry.cancelled=true;authenticationProcesses.delete(id);clearTimeout(entry.timer);entry.controller?.abort();
    if(entry.child?.pid)void terminateProcessTree(entry.child,{force:process.platform==='win32'});
    authenticationMessages.set(id,'登录已取消');await engine.refreshProviders();return {cancelled:true};
  });
  handle('openProvider',openProvider);
  handle('prepareHandoff',values=>{const handoff=engine.handoff(values);return {prompt:handoff.prompt};});
  handle('copyText',text=>{if(typeof text!=='string'||text.length>200000)throw new Error('复制内容不正确');clipboard.writeText(text);return true;});
  handle('completeHandoff',values=>engine.completeHandoff(values));
  handle('openWorkspace',async raw=>{const chosen=permittedWorkspace(raw);const error=await shell.openPath(chosen);if(error)throw new Error(error);return true;});
  handle('exportRun',async id=>{
    const run=engine.getRun(id);const report=markdownReport(run);
    const {canceled,filePath}=await dialog.showSaveDialog(win,{title:'导出任务结果与用量',defaultPath:path.join(app.getPath('documents'),`AgentFlow-${run.createdAt.slice(0,10)}-${run.id.slice(0,8)}.md`),filters:[{name:'Markdown 报告',extensions:['md']}]});
    if(canceled||!filePath)return null;fs.writeFileSync(filePath,report,{mode:0o600});return filePath;
  });
  handle('testProvider',async id=>{
    const provider=providerById(id);
    if(provider.mode==='api'){try{const result=await apiRegistry.probeProvider(id);return {ok:result.ready===true,provider:result};}finally{await engine.refreshProviders();}}
    if(!provider.executable||provider.mode!=='cli')throw new Error('这个应用尚未提供可验证的自动执行入口');
    if(typeof providersModule.probeProvider!=='function')throw new Error('当前版本尚未提供此入口的登录验证');
    let result;
    try{result=await providersModule.probeProvider({provider,nodePath:nodePath()});}catch(error){verifiedProviders.delete(provider.id);await engine.refreshProviders();throw error;}
    verifiedProviders.set(provider.id,{executable:provider.executable,at:Date.now(),modelId:result.verifiedModelId});
    await engine.refreshProviders();return {ok:true,usage:result.usage,
      modelId:redact(result.modelId||result.verifiedRequestModelId||result.verifiedModelId||'').slice(0,240),
      effort:result.verifiedEffort||'default'};
  });
  handle('refreshTelemetry',()=>{telemetry.refresh();return telemetry.get();});
}
function createWindow(){
  nativeTheme.themeSource='dark';
  win=new BrowserWindow({width:1440,height:940,minWidth:820,minHeight:640,show:true,title:'AgentFlow · 智能体工作台',backgroundColor:'#0a0a0d',...(process.platform==='darwin'?{titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:20}}:{}),icon:path.join(__dirname,'assets','icon.png'),
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,spellcheck:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!==uiURL)event.preventDefault();});
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  const session=win.webContents.session;
  session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.setPermissionCheckHandler(()=>false);
  session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,callback)=>callback({cancel:true}));
  win.once('ready-to-show',()=>ensureWindow());
  win.webContents.once('did-finish-load',()=>{ensureWindow();sendState();});
  win.on('closed',()=>{win=null;});
  windowLoadPromise=win.loadFile(uiFile);
  void windowLoadPromise.catch(()=>{dialog.showErrorBox('AgentFlow 页面未能打开','请退出后重新打开 AgentFlow。');});
}
function ensureWindow(){if(quitting||!engine)return;if(!win||win.isDestroyed?.()){if(app.isReady?.())createWindow();return;}if(win.isMinimized())win.restore();win.show();win.focus();}
function waitForWindowIdle(contents){
  if(!contents.isLoading())return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const finish=()=>{clearTimeout(timer);contents.removeListener('did-stop-loading',finish);resolve();};
    const timer=setTimeout(()=>{contents.removeListener('did-stop-loading',finish);reject(new Error('启动页面未完成加载'));},15000);
    contents.once('did-stop-loading',finish);
    if(!contents.isLoading())finish();
  });
}
app.on('second-instance',ensureWindow);
app.on('activate',ensureWindow);
app.whenReady().then(async()=>{
  if(!single)return;
  const dataDir=app.getPath('userData');
  apiRegistry=new ApiRegistry({dataDir,vault:{isAvailable:()=>safeStorage.isEncryptionAvailable(),encrypt:value=>safeStorage.encryptString(value),decrypt:value=>safeStorage.decryptString(value)}});
  telemetry=new Telemetry({helper:app.isPackaged?path.join(process.resourcesPath,'tokenlens-telemetry'):path.join(__dirname,'assets','tokenlens-telemetry'),onChange:sendState});
  conversationStore=new ConversationStore({dataDir,validate:({runId,stageId,attemptId})=>{const run=engine?.runs.find(row=>row.id===runId);if(!run)return false;if(stageId===undefined)return true;const stage=[...(run.starter?[run.starter]:[]),...run.stages].find(row=>row.id===stageId);return !!stage&&(attemptId===undefined||stage.attempts?.some(row=>row.id===attemptId)===true);}});
  engine=new Engine({dataDir,detectProviders,runProvider:runAgentProvider,onChange:sendState,telemetry:()=>telemetry.get(),conversationStore});
  registerIPC();createWindow();
  startupPromise=(async()=>{
    await apiRegistry.init();await engine.init();
    // Warm only explicitly known attempts, once. Graph snapshots subsequently
    // use public in-memory metadata rather than repeatedly reading full text.
    for(const run of engine.runs)for(const stage of [...(run.starter?[run.starter]:[]),...run.stages])for(const attempt of stage.attempts||[]){
      try{conversationStore.get({runId:run.id,stageId:stage.id,attemptId:attempt.id});}catch{}
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    initializing=false;sendState();
  })();
  await startupPromise;if(engine.config.workspace){try{approvedWorkspaces.add(validateWorkspace(engine.config.workspace));}catch{}}
  if(smokeTest){
    await windowLoadPromise;
    await waitForWindowIdle(win.webContents);
    fs.writeFileSync(path.join(dataDir,'smoke-result.json'),JSON.stringify({ok:true,version:app.getVersion(),platform:process.platform,arch:process.arch,windowLoaded:!win.webContents.isLoading(),providers:engine.providers.length}),{mode:0o600});
    process.stdout?.write('AGENTFLOW_SMOKE_OK\n');app.quit();return;
  }
  for(const r of engine.runs){try{approvedWorkspaces.add(validateWorkspace(r.workspace));}catch{}}
  discoveryWatcher=new DiscoveryWatcher({onChange:()=>engine.refreshProviders()});
  telemetry.start();discoveryWatcher.start();
}).catch(error=>{dialog.showErrorBox('AgentFlow 无法启动',redact(error.message));app.quit();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',event=>{
  if(quitting)return;quitting=true;telemetry?.stop();discoveryWatcher?.stop();
  for(const {child,timer,controller} of authenticationProcesses.values()){clearTimeout(timer);controller?.abort();if(child?.pid)void terminateProcessTree(child,{force:true});}
  if(engine?.controllers.size){event.preventDefault();engine.shutdown();setTimeout(()=>app.exit(0),1800);}else engine?.shutdown();
});
module.exports={markdownReport};

'use strict';

// This boundary never returns a credential. The original installed connector
// reads the original desktop store inside a private process; only the matching
// vendor CLI receives its access token through its documented environment input.
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const WORKBUDDY_APP='/Applications/WorkBuddy AI.app';
const ENDPOINT='https://www.workbuddy.ai';
const safeAbsolute=value=>typeof value==='string'&&path.isAbsolute(value)&&value.length<=4096&&!/[\u0000-\u001f\u007f]/.test(value);
const isFile=file=>{try{return fs.statSync(file).isFile();}catch{return false;}};
const isDirectory=file=>{try{return fs.lstatSync(file).isDirectory();}catch{return false;}};
function samePath(a,b,platform){return safeAbsolute(a)&&safeAbsolute(b)&&(platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b));}

// All paths must belong to the discovered applications' measured resource
// layout. An arbitrary executable or connector is never handed a desktop key.
function resolveWorkBuddyBridge(provider,{platform=process.platform}={}){
  const bridge=provider?.authBridge,connector=bridge?.connector;
  if(provider?.id!=='workbuddy'||bridge?.kind!=='workbuddy-desktop-credential'||!['darwin','win32'].includes(platform))throw new Error('没有经过确认的同厂商授权复用入口。');
  const appPath=provider.appPath||(platform==='darwin'?WORKBUDDY_APP:null);
  if(!safeAbsolute(appPath)||!safeAbsolute(connector?.entry)||!safeAbsolute(connector?.runtimeRoot)||!safeAbsolute(connector?.dshHome))throw new Error('没有经过确认的同厂商授权复用入口。');
  let resources,workbuddyElectron;
  if(platform==='darwin'){
    if(!['WorkBuddy AI.app','WorkBuddy.app'].includes(path.basename(appPath)))throw new Error('没有经过确认的同厂商授权复用入口。');
    resources=path.join(appPath,'Contents','Resources');workbuddyElectron=path.join(appPath,'Contents','MacOS','Electron');
  }else{
    if(!/^WorkBuddy(?: AI)?\.exe$/i.test(path.basename(appPath)))throw new Error('没有经过确认的同厂商授权复用入口。');
    resources=path.join(path.dirname(appPath),'resources');workbuddyElectron=appPath;
  }
  const cliPath=path.join(resources,'app.asar.unpacked','cli','dist','codebuddy-headless.js');
  const archive=path.dirname(connector.runtimeRoot),dshResources=path.dirname(archive);
  if(path.basename(connector.runtimeRoot)!=='dsh'||path.basename(archive)!=='app.asar'||path.basename(dshResources).toLowerCase()!=='resources')throw new Error('没有经过确认的同厂商授权复用入口。');
  let runtimeExecutable;
  if(platform==='darwin'){
    const contents=path.dirname(dshResources),dshApp=path.dirname(contents);
    if(path.basename(contents)!=='Contents'||path.basename(dshApp)!=='DeepSeek Harness.app')throw new Error('没有经过确认的同厂商授权复用入口。');
    runtimeExecutable=path.join(contents,'MacOS','DeepSeek Harness');
  }else runtimeExecutable=path.join(path.dirname(dshResources),'DeepSeek Harness.exe');
  if(!samePath(provider.executable,cliPath,platform)||bridge.runtimeExecutable&&!samePath(bridge.runtimeExecutable,runtimeExecutable,platform)||bridge.workbuddyElectron&&!samePath(bridge.workbuddyElectron,workbuddyElectron,platform))throw new Error('没有经过确认的同厂商授权复用入口。');
  try{
    const entry=fs.realpathSync(connector.entry),packageDir=path.dirname(path.dirname(entry)),packageFile=path.join(packageDir,'package.json');
    if(path.basename(entry)!=='index.js'||path.basename(path.dirname(entry))!=='lib'||fs.statSync(packageFile).size>256*1024||JSON.parse(fs.readFileSync(packageFile,'utf8')).name!=='dsh-workbuddy-connect')throw new Error();
  }catch{throw new Error('现有授权读取器不可用，请重新检测已安装的连接器。');}
  if(!isFile(cliPath)||!isFile(workbuddyElectron)||!isFile(runtimeExecutable)||!isFile(connector.entry)||!fs.existsSync(archive))throw new Error('现有授权读取器不可用，请在原应用登录后重新检测。');
  return {cliPath,runtimeExecutable,workbuddyElectron,runtimeRoot:connector.runtimeRoot,connectorEntry:connector.entry,dshHome:connector.dshHome};
}

function bridgeEnvironment(environment={}){
  const allowed=['HOME','PATH','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE',
    'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy',
    'SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','PATHEXT','ComSpec'];
  const env={};
  for(const name of allowed){
    const key=Object.hasOwn(environment,name)?name:Object.keys(environment).find(key=>key.toLowerCase()===name.toLowerCase());
    const value=environment[key];if(typeof value==='string'&&!value.includes('\0'))env[name]=value;
  }
  return env;
}

function redactVendorText(value,secrets=[]) {
  let text=String(value);
  for(const secret of secrets)if(typeof secret==='string'&&secret.length>=4)text=text.split(secret).join('[redacted]');
  return text.replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]');
}

function prepareVendorInvocation({provider,invocation,directory,platform=process.platform}={}){
  const resolved=resolveWorkBuddyBridge(provider,{platform});
  if(!safeAbsolute(directory)||!isDirectory(directory)
      ||!samePath(invocation?.args?.[0],resolved.cliPath,platform)||!safeAbsolute(invocation?.command)
      ||!/^node(?:\.exe)?$/i.test(path.basename(invocation.command))||!isFile(invocation.command)||!safeAbsolute(invocation.cwd)){
    throw new Error('没有经过确认的同厂商授权复用入口。');
  }
  const runtimePackage=pathToFileURL(path.join(resolved.runtimeRoot,'package.json')).href;
  const guardPath=path.join(directory,'workbuddy-endpoint-guard.mjs');
  fs.writeFileSync(guardPath,fs.readFileSync(path.join(__dirname,'vendor-endpoint-guard.mjs')),{mode:0o600,flag:'wx'});
  const childArgs=['--import',pathToFileURL(guardPath).href,...invocation.args];
  const script=`import {registerHooks} from 'node:module';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
registerHooks({resolve(specifier,context,nextResolve){return specifier.startsWith('@deepseek-ai/')?nextResolve(specifier,{...context,parentURL:${JSON.stringify(runtimePackage)}}):nextResolve(specifier,context);}});
let secrets=[],streamFailure=false,bridgeOutputBytes=0;
${redactVendorText.toString()}
const scrub=value=>redactVendorText(value,secrets);
function forward(stream,target,stop){
 const decoder=new StringDecoder('utf8');let pending='',settled=false;
 return new Promise(resolve=>{
  const finish=()=>{if(settled)return;settled=true;pending+=decoder.end();if(pending)target.write(scrub(pending));pending='';resolve();};
  stream.on('data',chunk=>{
   bridgeOutputBytes+=chunk.length;pending+=decoder.write(chunk);
   if(bridgeOutputBytes>16777216||Buffer.byteLength(pending)>1048576){streamFailure=true;pending='';stop();stream.destroy();process.stderr.write('WorkBuddy 输出超过安全边界。\\n');return;}
   let index;while((index=pending.indexOf('\\n'))!==-1){target.write(scrub(pending.slice(0,index))+'\\n');pending=pending.slice(index+1);}
  });
  stream.once('end',finish);stream.once('close',finish);
 });
}
try{
 const sdk=await import(${JSON.stringify(pathToFileURL(resolved.connectorEntry).href)});
 const variant=sdk.WORKBUDDY_VARIANTS.find(value=>value.id==='workbuddy-ai');
 if(!variant)throw new Error('missing variant');
 const client=new sdk.WorkBuddyUpstreamClient();
 const store=new sdk.WorkBuddyCredentialStore({variant,refresh:value=>client.refreshToken(value)});
 const current=await store.current();
 if(!current?.accessToken||sdk.regionOf(current.domain)!=='global')throw new Error('unavailable credential');
 // current() is deliberately read-only. Execution must use the connector's
 // supported demand-driven refresh, without rewriting the desktop auth file.
 if(typeof store.resolve!=='function')throw new Error('unsupported credential refresh');
 const credential=await store.resolve();
 if(!credential?.accessToken||sdk.regionOf(credential.domain)!=='global')throw new Error('unavailable credential');
 if(typeof credential.expiresAtMs==='number'&&credential.expiresAtMs<=Date.now())throw new Error('expired credential');
 secrets=[credential.accessToken,credential.refreshToken,credential.uid,credential.enterpriseId,credential.nickname];
 const childEnv={...process.env};
 // The official product endpoint and isolated in-memory auth prevent a custom
 // project setting or ambient API variable from redirecting this desktop token.
 for(const key of Object.keys(childEnv))if(/^(CODEBUDDY_(?:AUTH_TOKEN|API_KEY|BASE_URL)|ACC_PRODUCT_CONFIG|ACC_USER_|NODE_OPTIONS)/.test(key))delete childEnv[key];
 childEnv.CODEBUDDY_AUTH_TOKEN=credential.accessToken;
 childEnv.ACC_PRODUCT_CONFIG_V3=JSON.stringify({endpoint:${JSON.stringify(ENDPOINT)}});
 childEnv.CODEBUDDY_API_KEY_DISABLED='1';childEnv.CODEBUDDY_API_KEY_HELPER_DISABLED='1';
 childEnv.CODEBUDDY_CREDENTIALS_IN_MEMORY='1';
 childEnv.CODEBUDDY_DISABLE_PRODUCT_CACHE='1';
 if(credential.uid)childEnv.ACC_USER_ID=credential.uid;
 const child=spawn(${JSON.stringify(invocation.command)},${JSON.stringify(childArgs)},{cwd:${JSON.stringify(invocation.cwd)},env:childEnv,shell:false,stdio:['inherit','pipe','pipe']});
 let exited=false,forceTimer;
 const markExited=()=>{exited=true;clearTimeout(forceTimer);};
 child.once('exit',markExited);child.once('close',markExited);
 const stop=()=>{
  if(exited||child.exitCode!==null&&child.exitCode!==undefined||child.signalCode!==null&&child.signalCode!==undefined)return;
  child.kill('SIGTERM');
  if(exited)return;
  forceTimer=setTimeout(()=>{if(!exited&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1500);forceTimer.unref();
 };
 const stdoutDone=forward(child.stdout,process.stdout,stop),stderrDone=forward(child.stderr,process.stderr,stop);
 const outcome=await new Promise(resolve=>{child.once('error',()=>resolve({code:1}));child.once('close',(code,signal)=>resolve({code,signal}));});
 await Promise.all([stdoutDone,stderrDone]); // Flush both sanitized tails before clearing secret references.
 for(const key of ['CODEBUDDY_AUTH_TOKEN','ACC_PRODUCT_CONFIG_V3','ACC_USER_ID'])delete childEnv[key];
 secrets=[];
 process.exitCode=outcome.code===0&&!outcome.signal&&!streamFailure?0:1;
}catch{
 process.stderr.write('WorkBuddy 现有桌面授权不可用；请在 WorkBuddy AI 中登录后重新检测。\\n');
 process.exitCode=1;
}
`;
  const wrapper=path.join(directory,'workbuddy-desktop-auth.mjs');
  fs.writeFileSync(wrapper,script,{mode:0o600,flag:'wx'});
  const env={...bridgeEnvironment(invocation.env),ELECTRON_RUN_AS_NODE:'1',DSH_HOME:resolved.dshHome,
    WORKBUDDY_AI_ELECTRON_BIN:resolved.workbuddyElectron};
  // Caller-visible invocation contains no credential or account identity.
  for(const key of ['CODEBUDDY_AUTH_TOKEN','CODEBUDDY_API_KEY','CODEBUDDY_BASE_URL'])delete env[key];
  return {...invocation,command:resolved.runtimeExecutable,args:['--expose-internals',wrapper],env,shell:false,
    origin:'workbuddy-vendor-headless-with-desktop-credential'};
}

module.exports={prepareVendorInvocation,redactVendorText,resolveWorkBuddyBridge};

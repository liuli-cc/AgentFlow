'use strict';

// This boundary never returns a credential. The original installed connector
// reads the original desktop store inside a private process; only the matching
// vendor CLI receives its access token through its documented environment input.
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const WORKBUDDY_APP='/Applications/WorkBuddy AI.app';
const WORKBUDDY_CLI=path.join(WORKBUDDY_APP,'Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-headless.js');
const DSH_EXECUTABLE='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const ENDPOINT='https://www.workbuddy.ai';

function redactVendorText(value,secrets=[]) {
  let text=String(value);
  for(const secret of secrets)if(typeof secret==='string'&&secret.length>=4)text=text.split(secret).join('[redacted]');
  return text.replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]');
}

function prepareVendorInvocation({provider,invocation,directory}={}){
  const bridge=provider?.authBridge;
  if(provider?.id!=='workbuddy'||provider.executable!==WORKBUDDY_CLI||bridge?.kind!=='workbuddy-desktop-credential'
      ||!bridge.connector?.entry||!bridge.connector?.runtimeRoot||!path.isAbsolute(directory)
      ||invocation?.args?.[0]!==WORKBUDDY_CLI||!path.isAbsolute(invocation.command)){
    throw new Error('没有经过确认的同厂商授权复用入口。');
  }
  if(!fs.existsSync(DSH_EXECUTABLE)||!fs.existsSync(bridge.connector.entry))throw new Error('现有授权读取器不可用，请在原应用登录后重新检测。');
  const runtimePackage=pathToFileURL(path.join(bridge.connector.runtimeRoot,'package.json')).href;
  const guardPath=path.join(directory,'workbuddy-endpoint-guard.mjs');
  fs.writeFileSync(guardPath,fs.readFileSync(path.join(__dirname,'vendor-endpoint-guard.mjs')),{mode:0o600});
  const childArgs=['--import',guardPath,...invocation.args];
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
 const sdk=await import(${JSON.stringify(pathToFileURL(bridge.connector.entry).href)});
 const variant=sdk.WORKBUDDY_VARIANTS.find(value=>value.id==='workbuddy-ai');
 if(!variant)throw new Error('missing variant');
 const client=new sdk.WorkBuddyUpstreamClient();
 const store=new sdk.WorkBuddyCredentialStore({variant,refresh:value=>client.refreshToken(value)});
 const credential=await store.current();
 if(!credential?.accessToken||sdk.regionOf(credential.domain)!=='global')throw new Error('unavailable credential');
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
 const stop=()=>{child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),1500);timer.unref();};
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
  fs.writeFileSync(wrapper,script,{mode:0o600});
  const env={...invocation.env,ELECTRON_RUN_AS_NODE:'1',DSH_HOME:bridge.connector.dshHome,
    WORKBUDDY_AI_ELECTRON_BIN:path.join(WORKBUDDY_APP,'Contents/MacOS/Electron')};
  // Caller-visible invocation contains no credential or account identity.
  for(const key of ['CODEBUDDY_AUTH_TOKEN','CODEBUDDY_API_KEY','CODEBUDDY_BASE_URL'])delete env[key];
  return {...invocation,command:DSH_EXECUTABLE,args:['--expose-internals',wrapper],env,
    origin:'workbuddy-vendor-headless-with-desktop-credential'};
}

module.exports={prepareVendorInvocation,redactVendorText};

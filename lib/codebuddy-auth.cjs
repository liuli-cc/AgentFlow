'use strict';
// Official CodeBuddy Code ACP authentication. Catalog inspection creates only an
// empty ephemeral session; no userinfo, prompt, filesystem or terminal method.
// https://www.codebuddy.ai/docs/cli/acp
// https://www.codebuddy.ai/docs/cli/quickstart
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {terminateProcessTree}=require('./runtime.cjs');

const METHODS=Object.freeze({
  internal:Object.freeze({id:'internal',name:'国内账号 · 微信'}),
  external:Object.freeze({id:'external',name:'国际账号 · Google / GitHub'}),
});
const MAX_OUTPUT=2*1024*1024;
const MAX_LINE=1024*1024;
const safeAbsolute=value=>typeof value==='string'&&path.isAbsolute(value)&&value.length<=4096&&!/[\u0000-\u001f\u007f]/.test(value);

function codeBuddyEnvironment(environment=process.env,{methodId}={}){
  const keys=['HOME','PATH','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE',
    'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy',
    'SystemRoot','SYSTEMROOT','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','PATHEXT','ComSpec','COMSPEC'];
  const env={};
  for(const key of keys)if(typeof environment[key]==='string'&&!environment[key].includes('\0'))env[key]=environment[key];
  // This is a product-owned config location, not a credential exported by us.
  if(safeAbsolute(environment.CODEBUDDY_CONFIG_DIR))env.CODEBUDDY_CONFIG_DIR=environment.CODEBUDDY_CONFIG_DIR;
  env.DISABLE_AUTOUPDATER='1';
  // The official CodeBuddy and WorkBuddy runtimes share ProductManager's disk
  // cache keys. A WorkBuddy snapshot can otherwise override the CodeBuddy login
  // product, and switch(internal) returns early when env is already internal.
  // The vendor-supported switch disables both cache load and cache save.
  env.CODEBUDDY_DISABLE_PRODUCT_CACHE='1';
  if(methodId==='internal'||methodId==='external')env.CODEBUDDY_INTERNET_ENVIRONMENT=methodId;
  // Deliberately omit CODEBUDDY_API_KEY/AUTH_TOKEN, NODE_OPTIONS, extra headers,
  // custom endpoint overrides and inherited product/enterprise configuration.
  return env;
}

function createCodeBuddyInvocation({cliPath,nodePath=process.execPath,cwd,env=process.env,methodId}={}){
  if(!safeAbsolute(cliPath)||!safeAbsolute(nodePath)||!/^node(?:\.exe)?$/i.test(path.basename(nodePath))||!safeAbsolute(cwd))throw new Error('CodeBuddy 官方组件路径无效');
  if(methodId!==undefined&&!Object.hasOwn(METHODS,methodId))throw new Error('请选择支持的 CodeBuddy 登录区域');
  let realCLI,packageDir,metadata;
  try{
    realCLI=fs.realpathSync(cliPath);
    packageDir=path.dirname(path.dirname(realCLI));
    metadata=JSON.parse(fs.readFileSync(path.join(packageDir,'package.json'),'utf8'));
    if(path.basename(realCLI)!=='codebuddy'||path.basename(path.dirname(realCLI))!=='bin'||
      metadata.name!=='@tencent-ai/codebuddy-code'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(metadata.version)||
      !fs.statSync(realCLI).isFile()||!fs.statSync(cwd).isDirectory()||!fs.statSync(nodePath).isFile())throw new Error();
  }catch{throw new Error('未找到已验证的 CodeBuddy 官方命令行组件');}
  return {command:nodePath,args:[realCLI,'--acp','--acp-transport','stdio','--tools','',
    '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','none',
    '--no-session-persistence'],cwd,env:codeBuddyEnvironment(env,{methodId}),shell:false,
    packageVersion:metadata.version};
}

function abortError(){const error=new Error('CodeBuddy 登录已取消');error.name='AbortError';return error;}

function publicCatalog(result){
  const safeText=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]|:\/\//.test(value);
  const configs=Array.isArray(result.configOptions)?result.configOptions:[];
  const modelConfig=configs.find(x=>x&&(x.id==='model'||x.configId==='model'||x.category==='model'));
  const thinking=configs.find(x=>x&&(x.id==='thought_level'||x.configId==='thought_level'||x.category==='thought_level'));
  const options=values=>Array.isArray(values)?values.flatMap(x=>Array.isArray(x?.options)?x.options:[x]):[];
  const defaultModelId=safeText(result.models?.currentModelId)?result.models.currentModelId:safeText(modelConfig?.currentValue)?modelConfig.currentValue:null;
  const efforts=options(thinking?.options).map(x=>x?.value).filter(x=>['minimal','low','medium','high','xhigh','max'].includes(x));
  const rows=Array.isArray(result.models?.availableModels)?result.models.availableModels:options(modelConfig?.options).map(x=>({modelId:x?.value,name:x?.name}));
  const seen=new Set();const models=[];
  for(const row of rows.slice(0,500)){
    if(!safeText(row?.modelId)||seen.has(row.modelId))continue;seen.add(row.modelId);
    models.push({id:row.modelId,label:safeText(row.name)?row.name:row.modelId,
      efforts:['default',...new Set(row.modelId===defaultModelId?efforts:[])],source:'codebuddy-acp-session'});
  }
  return {authenticated:true,executionVerified:false,defaultModelId,models,source:'codebuddy-acp-session'};
}

function runACP(options,authenticate,catalog=false){
  const {signal,onStarted,spawnImpl=spawn,killImpl=(pid,sig)=>process.kill(pid,sig)}=options||{};
  if(signal?.aborted)return Promise.reject(abortError());
  let invocation;
  try{invocation=createCodeBuddyInvocation(options);}catch(error){return Promise.reject(error);}
  const timeoutMs=Math.min(authenticate?300000:45000,Math.max(1000,Number(options.timeoutMs)||(authenticate?300000:30000)));
  if(authenticate&&!Object.hasOwn(METHODS,options.methodId))return Promise.reject(new Error('请选择 CodeBuddy 登录区域'));
  return new Promise((resolve,reject)=>{
    let child,buffer='',outputBytes=0,settled=false,initialized=false,exited=false,closed=false,forceTimer;
    const timer=setTimeout(()=>finish(new Error(authenticate?'CodeBuddy 登录超时，请重试':'CodeBuddy 登录入口检测超时')),timeoutMs);
    const cancel=()=>finish(abortError());
    function stop(){
      if(!child?.pid||exited||child.exitCode!==null&&child.exitCode!==undefined||child.signalCode!==null&&child.signalCode!==undefined)return;
      if(process.platform==='win32'&&!options.killImpl)void terminateProcessTree(child,{force:true});else try{killImpl(process.platform==='win32'?child.pid:-child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
      if(exited)return;
      forceTimer=setTimeout(()=>{if(exited||child.exitCode!==null&&child.exitCode!==undefined||child.signalCode!==null&&child.signalCode!==undefined)return;if(process.platform==='win32'&&!options.killImpl)void terminateProcessTree(child,{force:true});else try{killImpl(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{}},500);forceTimer.unref?.();
    }
    function finish(error,value){
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      // On Windows a running process locks its cwd. Do not allow callers to
      // remove the owned temporary workspace until the CLI and pipes close.
      let delivered=false,cleanupTimer;
      const deliver=cleanupError=>{if(delivered)return;delivered=true;clearTimeout(cleanupTimer);if(cleanupError||error)reject(cleanupError||error);else resolve(value);};
      const waitForClose=!!child?.pid&&!closed;
      if(waitForClose){
        child.once('close',()=>deliver());
        cleanupTimer=setTimeout(()=>deliver(new Error('CodeBuddy 登录进程未能确认停止，请重试')),5000);cleanupTimer.unref?.();
      }
      stop();
      if(!waitForClose)deliver();
    }
    function send(value){
      if(settled)return;
      try{child.stdin.write(`${JSON.stringify(value)}\n`);}catch{finish(new Error('CodeBuddy 登录通信中断'));}
    }
    function receive(value){
      if(!value||typeof value!=='object'||Array.isArray(value))return;
      // Refuse all server-side requests, including file/terminal/permission APIs.
      if(typeof value.method==='string'){
        if(Object.hasOwn(value,'id'))send({jsonrpc:'2.0',id:value.id,error:{code:-32601,message:'Method not supported'}});
        return;
      }
      if(value.id===1&&!initialized){
        if(value.error||!value.result||value.result.protocolVersion!==1||!Array.isArray(value.result.authMethods))return finish(new Error('CodeBuddy 登录协议不可用'));
        initialized=true;
        const advertised=new Set(value.result.authMethods.map(x=>x&&x.id));
        const authMethods=Object.values(METHODS).filter(x=>advertised.has(x.id)).map(x=>({...x}));
        if(catalog){
          send({jsonrpc:'2.0',id:3,method:'session/new',params:{cwd:invocation.cwd,mcpServers:[]}});
          return;
        }
        if(!authenticate)return finish(null,{protocolVersion:1,authMethods,packageVersion:invocation.packageVersion});
        if(!advertised.has(options.methodId))return finish(new Error('此 CodeBuddy 版本不支持所选登录区域'));
        // IMPORTANT: the official authenticate method may log out an existing
        // CLI account before opening its browser. This is never called by inspect.
        send({jsonrpc:'2.0',id:2,method:'authenticate',params:{methodId:options.methodId}});
        if(!settled&&typeof onStarted==='function')try{onStarted({started:true,kind:'browser-cli',methodId:options.methodId});}catch{}
      }else if(value.id===3&&initialized&&catalog){
        if(value.error){
          // ACP SDK authRequired=-32000, vendor category explicitly confirms auth.
          if(value.error.code===-32000&&value.error.data?.category==='auth')return finish(null,
            {authenticated:false,executionVerified:false,defaultModelId:null,models:[],source:'codebuddy-acp-session'});
          return finish(new Error('CodeBuddy 模型目录暂不可用'));
        }
        if(!value.result||typeof value.result!=='object'||Array.isArray(value.result))return finish(new Error('CodeBuddy 模型目录暂不可用'));
        // --no-session-persistence makes this empty session process-owned. Stop
        // the process after extracting public fields; never send session/prompt.
        return finish(null,publicCatalog(value.result));
      }else if(value.id===2&&initialized&&authenticate){
        if(value.error||!value.result||typeof value.result!=='object'||Array.isArray(value.result))return finish(new Error('CodeBuddy 官方登录未完成，请重试'));
        // Discard the entire response: its _meta may contain identity details.
        finish(null,{authenticated:true,methodId:options.methodId});
      }
    }
    try{
      child=spawnImpl(invocation.command,invocation.args,{cwd:invocation.cwd,env:invocation.env,shell:false,
        detached:process.platform!=='win32',windowsHide:true,stdio:['pipe','pipe','ignore']});
      child.once('error',()=>finish(new Error('无法启动 CodeBuddy 官方登录')));
      const exitedHandler=()=>{exited=true;clearTimeout(forceTimer);finish(new Error('CodeBuddy 登录进程已结束'));};
      child.once('exit',exitedHandler);
      child.once('close',()=>{closed=true;exitedHandler();});
      child.stdin.on('error',()=>finish(new Error('CodeBuddy 登录通信中断')));
      child.stdout.on('data',chunk=>{
        if(settled)return;
        outputBytes+=chunk.length;
        if(outputBytes>MAX_OUTPUT)return finish(new Error('CodeBuddy 登录响应超出限制'));
        buffer+=chunk.toString('utf8');
        if(Buffer.byteLength(buffer)>MAX_LINE)return finish(new Error('CodeBuddy 登录响应超出限制'));
        let split;
        while(!settled&&(split=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,split);buffer=buffer.slice(split+1);
          let value;try{value=JSON.parse(line);}catch{continue;}
          receive(value);
        }
      });
      signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted)return cancel();
      send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:1,
        clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},
        clientInfo:{name:'AgentFlow',version:'0.3.0'}}});
    }catch{finish(new Error('无法启动 CodeBuddy 官方登录'));}
  });
}

function inspectCodeBuddyAuth(options){return runACP(options,false);}
function inspectCodeBuddyCatalog(options){return runACP(options,false,true);}
// Call only after an explicit login click. Never call from discovery/refresh.
function authenticateCodeBuddy(options){return runACP(options,true);}
module.exports={createCodeBuddyInvocation,codeBuddyEnvironment,inspectCodeBuddyAuth,inspectCodeBuddyCatalog,authenticateCodeBuddy};

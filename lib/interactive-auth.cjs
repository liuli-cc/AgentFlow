'use strict';
// Terminal login is owned by the official CLI. Only process metadata is read
// back; terminal input and credentials never enter AgentFlow or these files.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {terminateProcessTree}=require('./runtime.cjs');
const ALLOWED_ENV=new Set(['HOME','USERPROFILE','PATH','Path','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE','TERM','COLORTERM','SystemRoot','SYSTEMROOT','WINDIR','APPDATA','LOCALAPPDATA','PATHEXT','ComSpec','COMSPEC']);
const PROXY_ENV=new Set(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']);
function terminalEnvironment(environment={}, {platform=process.platform}={}){
  const result=Object.fromEntries(Object.entries(environment).filter(([key,value])=>ALLOWED_ENV.has(key)&&typeof value==='string'&&value.length<=65536&&!value.includes('\0')));
  for(const [key,value] of Object.entries(environment)){
    if(!PROXY_ENV.has(key)||value==='')continue;
    let safe=typeof value==='string'&&value.length<=8192&&!/[\u0000-\u001f]/.test(value);
    if(safe&&key.toLowerCase()==='no_proxy')safe=/^[A-Za-z0-9._:*[\], /-]+$/.test(value);
    else if(safe){try{const url=new URL(value);safe=['http:','https:','socks:','socks4:','socks5:','socks5h:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{safe=false;}}
    if(!safe)throw new Error('终端登录代理包含凭据或不支持的格式；请改用不带账号密码的本地代理。');
    result[key]=value;
  }
  if(environment.GEMINI_CLI_HOME!==undefined){const value=environment.GEMINI_CLI_HOME,p=platform==='win32'?path.win32:path;
    if(typeof value!=='string'||!p.isAbsolute(value)||/[\u0000-\u001f\u007f]/.test(value)||value.length>4096)throw new Error('GEMINI_CLI_HOME 必须是有效的绝对路径。');
    result.GEMINI_CLI_HOME=value;
  }
  return result;
}
const posixQuote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
const RUNNER=String.raw`'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const configFile=process.argv[2],directory=fs.realpathSync(path.dirname(configFile));
if(fs.lstatSync(configFile).isSymbolicLink()||path.basename(configFile)!=='invocation.json')throw new Error('Invalid login configuration');
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
if(!/^[a-f0-9]{48}$/.test(config.nonce)||!path.isAbsolute(config.command)||!path.isAbsolute(config.cwd)||!Array.isArray(config.args)||config.args.some(x=>typeof x!=='string'||x.includes('\0')))throw new Error('Invalid login invocation');
const resultFile=path.join(directory,'result.json'),pidFile=path.join(directory,'pid.json'),runnerPidFile=path.join(directory,'runner-pid.json'),cancelFile=path.join(directory,'cancel.json');
const write=(file,value)=>{const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify({...value,nonce:config.nonce}),{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);};
write(runnerPidFile,{pid:process.pid});
let child,ended=false,cancelled=false,timer;
function stop(){
 cancelled=true;if(!child?.pid)return;
 if(process.platform==='win32'){
  const root=config.env.SystemRoot||config.env.SYSTEMROOT||'C:\\Windows';
  const killer=spawn(path.win32.join(root,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.on('error',()=>{try{child.kill();}catch{}});
 }else{try{process.kill(-child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
  setTimeout(()=>{if(!ended)try{process.kill(-child.pid,'SIGKILL');}catch{}},1000).unref();}
}
function finish(code,signal,error){if(ended)return;ended=true;clearInterval(timer);write(resultFile,{code:Number.isInteger(code)?code:null,signal:typeof signal==='string'?signal:null,cancelled,error:error?'官方登录程序未能启动':undefined,finishedAt:new Date().toISOString()});process.exitCode=cancelled?130:Number.isInteger(code)?code:1;}
if(fs.existsSync(cancelFile)){cancelled=true;finish(null,null);}
else{
 try{child=spawn(config.command,config.args,{cwd:config.cwd,env:config.env,stdio:'inherit',shell:false,windowsHide:false,detached:process.platform!=='win32'});
  if(child.pid)write(pidFile,{pid:child.pid});child.once('error',()=>finish(null,null,true));child.once('close',(code,signal)=>finish(code,signal));
  timer=setInterval(()=>{try{const row=JSON.parse(fs.readFileSync(cancelFile,'utf8'));if(row.nonce===config.nonce)stop();}catch{}},200);timer.unref();
 }catch{finish(null,null,true);}
}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
`;
function validateInvocation(invocation,{nodePath,home,platform}){
  const p=platform==='win32'?path.win32:path;
  for(const value of [nodePath,home,invocation?.command])if(typeof value!=='string'||!p.isAbsolute(value)||/[\u0000-\u001f\u007f]/.test(value)||value.length>4096)throw new Error('终端登录入口必须是有效的绝对路径。');
  if(!Array.isArray(invocation.args)||invocation.args.length>64||invocation.args.some(arg=>typeof arg!=='string'||arg.length>8192||/[\u0000-\u001f\u007f]/.test(arg)||/^--?(?:api[-_]?key|(?:access|refresh)[-_]?token|token|password|client[-_]?secret)(?:=|$)/i.test(arg)))throw new Error('终端登录参数无效或包含凭据。');
  if(invocation.shell===true||invocation.stdin)throw new Error('终端登录不接受 shell 或预填认证输入。');
}
function launchInteractiveAuth({invocation,nodePath=process.execPath,home=os.homedir(),platform=process.platform,env=process.env,baseDirectory=os.tmpdir(),timeoutMs=5*60*1000,pollIntervalMs=200,spawnImpl=spawn,terminateImpl=terminateProcessTree}={}){
  if(!['darwin','win32'].includes(platform))throw new Error('此系统尚未提供已验证的交互登录终端入口。');
  validateInvocation(invocation,{nodePath,home,platform});
  if(!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>30*60*1000)throw new Error('登录等待时间无效。');
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(baseDirectory,'agentflow-login-')));fs.chmodSync(directory,0o700);
  const nonce=crypto.randomBytes(24).toString('hex'),configFile=path.join(directory,'invocation.json'),runnerFile=path.join(directory,'runner.cjs');
  const resultFile=path.join(directory,'result.json'),pidFile=path.join(directory,'pid.json'),cancelFile=path.join(directory,'cancel.json');
  let environment;
  try{environment=terminalEnvironment({...env,...invocation.env},{platform});}catch(error){fs.rmSync(directory,{recursive:true,force:true});throw error;}
  if(platform==='win32')environment.USERPROFILE=home;else environment.HOME=home;
  const config={nonce,command:invocation.command,args:[...invocation.args],cwd:home,env:environment};
  fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600,flag:'wx'});fs.writeFileSync(runnerFile,RUNNER,{mode:0o600,flag:'wx'});
  let child,settled=false,cancelled=false,timedOut=false,pollTimer,timeoutTimer,cancelTimer,resolveCompletion,rejectCompletion;
  const completion=new Promise((resolve,reject)=>{resolveCompletion=resolve;rejectCompletion=reject;});completion.catch(()=>{});
  function read(file){try{if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>16384)return null;const value=JSON.parse(fs.readFileSync(file,'utf8'));return value.nonce===nonce?value:null;}catch{return null;}}
  function finish(result,error){if(settled)return;settled=true;clearInterval(pollTimer);clearTimeout(timeoutTimer);clearTimeout(cancelTimer);error?rejectCompletion(error):resolveCompletion({...result,cancelled:cancelled||result.cancelled===true,timedOut});}
  async function stopActual(){const pid=read(pidFile)?.pid;
    if(Number.isSafeInteger(pid)&&pid>0&&pid!==process.pid){try{await terminateImpl({pid},{force:true,platform});}catch{}return;}
    const runnerPid=read(path.join(directory,'runner-pid.json'))?.pid;
    if(Number.isSafeInteger(runnerPid)&&runnerPid>0&&runnerPid!==process.pid)try{if(platform==='win32')await terminateImpl({pid:runnerPid},{force:true,platform});else process.kill(runnerPid,'SIGTERM');}catch{}
  }
  function cancel({timeout=false}={}){
    if(settled)return completion;cancelled=true;timedOut=timedOut||timeout;
    try{fs.writeFileSync(cancelFile,JSON.stringify({nonce}),{mode:0o600});}catch{}
    void stopActual();
    if(!cancelTimer)cancelTimer=setTimeout(()=>{void stopActual();finish({code:null,signal:null,cancelled:true});},1500);
    return completion;
  }
  async function cleanup(){if(!settled)await cancel();try{if(!fs.lstatSync(directory).isSymbolicLink()&&fs.realpathSync(directory)===directory)fs.rmSync(directory,{recursive:true,force:true});}catch{}}
  try{
    if(platform==='darwin'){
      const commandFile=path.join(directory,'login.command');
      fs.writeFileSync(commandFile,'#!/bin/sh\nunset NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE\nexec '+[nodePath,runnerFile,configFile].map(posixQuote).join(' ')+'\n',{mode:0o700,flag:'wx'});
      child=spawnImpl('/usr/bin/open',['-a','Terminal',commandFile],{shell:false,env:environment,stdio:'ignore',windowsHide:false});
    }else{
      const systemRoot=environment.SystemRoot||environment.SYSTEMROOT||'C:\\Windows';
      child=spawnImpl(path.win32.join(systemRoot,'System32','conhost.exe'),[nodePath,runnerFile,configFile],{shell:false,env:environment,stdio:'ignore',windowsHide:false});
    }
    child.once('error',()=>finish(null,new Error('无法打开系统登录终端。')));
    child.once('close',code=>{if(code!==0&&code!==null&&!read(resultFile))finish(null,new Error('系统登录终端未能正常启动。'));});
    pollTimer=setInterval(()=>{const result=read(resultFile);if(result&&('code'in result))finish({code:Number.isInteger(result.code)?result.code:null,signal:typeof result.signal==='string'?result.signal:null,cancelled:result.cancelled===true,error:result.error});else if(cancelled)void stopActual();},Math.max(20,pollIntervalMs));
    timeoutTimer=setTimeout(()=>cancel({timeout:true}),timeoutMs);
  }catch(error){finish(null,new Error('无法启动系统登录终端。'));void cleanup();throw error;}
  return {child,completion,cancel,cleanup,directory};
}
module.exports={launchInteractiveAuth,terminalEnvironment};

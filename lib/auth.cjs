'use strict';
// Authentication is delegated to the installed product. AgentFlow does not read,
// copy, export, or exchange its credentials and does not assemble OAuth URLs.
// Codex: https://learn.chatgpt.com/docs/auth
// Claude: installed `claude auth login --help` / official Claude Code browser login.
// DSH: official deepseek-account-platform requires its original Host callback server.
const path=require('node:path');
const {publicPackage,resolveCLIInvocation}=require('./runtime.cjs');
const {describeGoogleAuth,googleAuthInvocation}=require('./google-agents.cjs');

const DESKTOP_IDS=new Set(['dsh','opencode','marvis','doubao','workbuddy','codebuddy']);
const DESKTOP_MESSAGES={
  dsh:'在 DeepSeek Harness 原应用中完成官方账号或连接器登录；AgentFlow 重新检测其原有授权。',
  opencode:'账号和模型由 OpenCode 原应用管理，外部执行权限另行验证。',
  marvis:'账号由马维斯原应用管理，当前执行接口待接入。',
  doubao:'账号由豆包原应用管理，当前执行接口待接入。',
  workbuddy:'在 WorkBuddy 原应用中完成官方登录，再验证独立执行入口。',
  codebuddy:'在 CodeBuddy 原应用中完成官方登录，再验证独立执行入口。',
};
function safePath(value,suffix,platform=process.platform){return typeof value==='string'&&(platform==='win32'?path.win32:path).isAbsolute(value)&&value.length<=4096&&!/[\u0000-\u001f\u007f]/.test(value)&&(!suffix||value.endsWith(suffix));}
function cli(provider,name,platform=process.platform){
  if(!safePath(provider?.executable,undefined,platform)||provider.mode!=='cli')return false;
  const basename=(platform==='win32'?path.win32:path).basename(provider.executable).toLowerCase();
  return basename===name||platform==='win32'&&basename===name+'.exe'||publicPackage(provider.executable)?.name===({codex:'@openai/codex',claude:'@anthropic-ai/claude-code',codebuddy:'@tencent-ai/codebuddy-code'}[name]);
}
function authEnvironment(id,environment=process.env){
  const allowed=new Set(['HOME','PATH','Path','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE',
    'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy',
    'SystemRoot','SYSTEMROOT','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','PATHEXT','ComSpec','COMSPEC']);
  if(id==='codex')allowed.add('CODEX_HOME');
  if(id==='claude')allowed.add('CLAUDE_CONFIG_DIR');
  if(id==='gemini')allowed.add('GEMINI_CLI_HOME');
  return Object.fromEntries(Object.entries(environment).filter(([key,value])=>allowed.has(key)&&typeof value==='string'&&!value.includes('\0')));
}
function describeAuth(provider,{platform=process.platform}={}){
  if(!provider||typeof provider!=='object')return {kind:'none',label:'未安装',canStart:false,state:'unavailable',executionReady:false};
  const id=provider.id;
  const google=describeGoogleAuth(provider);if(google)return google;
  const executionReady=provider.ready===true&&['cli','api'].includes(provider.mode)&&provider.models?.some(model=>model.ready===true)===true;
  if(id==='codex'&&cli(provider,'codex',platform))return {kind:'browser-cli',label:'登录 ChatGPT',canStart:true,state:executionReady?'verified':'unverified',executionReady,
    browserFlow:true,credentialOwner:'Codex',message:'由官方 Codex CLI 打开系统浏览器，登录状态仍保存在 Codex。'};
  if(id==='claude'&&cli(provider,'claude',platform))return {kind:'browser-cli',label:'登录 Claude Code',canStart:true,state:executionReady?'verified':'unverified',executionReady,
    browserFlow:true,credentialOwner:'Claude Code',message:'由官方 Claude Code 打开系统浏览器并保存其自身登录状态。'};
  if(id==='codebuddy'&&cli(provider,'codebuddy',platform))return {kind:'browser-cli',label:'网页登录',canStart:true,state:executionReady?'verified':'unverified',executionReady,
    browserFlow:true,credentialOwner:'CodeBuddy Code',methods:[{id:'internal',label:'微信登录'},{id:'external',label:'国际账号登录'}],
    message:'使用官方 CodeBuddy Code 网页授权，账号仍保存在 CodeBuddy。'};
  if((DESKTOP_IDS.has(id)||/^app-[a-f0-9]{20}$/.test(id||''))&&provider.installed===true&&safePath(provider.appPath,undefined,platform)&&
      (platform==='win32'?/\.exe$/i.test(provider.appPath):provider.appPath.endsWith('.app')))return {
    kind:'desktop',label:provider.mode==='handoff'?'打开原应用':'打开原应用登录',canStart:true,state:'unknown',executionReady,browserFlow:false,
    credentialOwner:typeof provider.name==='string'?provider.name.slice(0,100):id,message:DESKTOP_MESSAGES[id]||'在原应用完成登录；未验证的自动执行入口保持不可用。',
  };
  return {kind:'none',label:provider.mode==='api'?'配置 API':'未提供登录入口',canStart:false,state:'unavailable',executionReady,browserFlow:false};
}
function createAuthInvocation(provider,{nodePath,platform=process.platform}={}){
  const description=describeAuth(provider,{platform});
  if(['gemini','antigravity'].includes(provider?.id)&&provider.mode==='cli')return googleAuthInvocation(provider,{nodePath,platform,env:authEnvironment(provider.id)});
  if(!description.canStart)throw new Error('这个智能体没有已验证的官方登录入口');
  if(description.kind==='browser-cli'){
    if(provider.id==='codex'&&cli(provider,'codex',platform))return resolveCLIInvocation({executable:provider.executable,args:['login'],nodePath,env:authEnvironment('codex'),platform});
    if(provider.id==='claude'&&cli(provider,'claude',platform))return resolveCLIInvocation({executable:provider.executable,args:['auth','login','--claudeai'],nodePath,env:authEnvironment('claude'),platform});
    throw new Error('这个智能体没有已验证的官方网页登录命令');
  }
  if(description.kind==='desktop'&&platform==='win32')return {command:provider.appPath,args:[],env:authEnvironment(provider.id),shell:false};
  if(description.kind==='desktop'&&safePath(provider.appPath,'.app'))return {command:'/usr/bin/open',args:['-a',provider.appPath],env:authEnvironment(provider.id)};
  throw new Error('无法启动官方登录入口');
}
module.exports={describeAuth,createAuthInvocation,authEnvironment};

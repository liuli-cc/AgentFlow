'use strict';
// Official interfaces only. Credentials remain owned by the installed CLI.
// https://antigravity.google/docs/cli/{install,headless}/
// https://github.com/google-gemini/gemini-cli/tree/main/packages/core/src/output
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {findCLI,resolveCLIInvocation}=require('./runtime.cjs');
const FIELDS=['input','output','cacheRead','cacheWrite','reasoning','costUSD'];
const emptyUsage=()=>Object.fromEntries(FIELDS.map(key=>[key,null]));
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const text=value=>typeof value==='string'?value:'';
const id=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!value.startsWith('-')&&!/[\s\u0000-\u001f\u007f]/.test(value);
// Exact stable minor audited against official v0.64.0 source. Fail closed on
// older/future schemas until their startup-integration switches are reviewed.
const supportedProbeVersion=version=>/^0\.64\.\d+$/.test(version||'');
const COMMON_ENV=new Set(['HOME','USERPROFILE','PATH','Path','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE','TERM','COLORTERM','SystemRoot','SYSTEMROOT','WINDIR','APPDATA','LOCALAPPDATA','PATHEXT','ComSpec','COMSPEC','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']);
const GEMINI_ENV=new Set(['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_CLOUD_API_KEY','GOOGLE_GENAI_USE_VERTEXAI','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GOOGLE_APPLICATION_CREDENTIALS','GEMINI_CLI_HOME','GEMINI_CLI_SYSTEM_SETTINGS_PATH','GEMINI_CLI_SYSTEM_DEFAULTS_PATH']);
function googleEnvironment(providerId,environment={}){return Object.fromEntries(Object.entries(environment).filter(([key,value])=>(COMMON_ENV.has(key)||providerId==='gemini'&&GEMINI_ENV.has(key)||providerId==='antigravity'&&['AGY_ADC_AUTH','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GOOGLE_APPLICATION_CREDENTIALS'].includes(key))&&typeof value==='string'&&!value.includes('\0')));}
function geminiConfigured({home,env,platform}){
  const p=platform==='win32'?path.win32:path,root=env.GEMINI_CLI_HOME&&p.isAbsolute(env.GEMINI_CLI_HOME)?env.GEMINI_CLI_HOME:home;
  let selectedType=null;
  try{const file=p.join(root,'.gemini','settings.json');if(fs.statSync(file).size<=64*1024){const settings=JSON.parse(fs.readFileSync(file,'utf8'));const value=settings?.security?.auth?.selectedType;
    if(['oauth-personal','gemini-api-key','vertex-ai','compute-default-credentials'].includes(value))selectedType=value;}}
  catch{}
  let cached=false;try{cached=fs.statSync(p.join(root,'.gemini','oauth_creds.json')).isFile();}catch{}
  const api=['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_CLOUD_API_KEY'].some(key=>typeof env[key]==='string'&&!!env[key]);
  return {configured:!!selectedType||cached||api||env.GOOGLE_GENAI_USE_VERTEXAI==='true'||!!env.GOOGLE_APPLICATION_CREDENTIALS,selectedType};
}
function systemGeminiPolicies(platform,env){
  const p=platform==='win32'?path.win32:path,root=platform==='darwin'?'/Library/Application Support/GeminiCli':platform==='win32'?'C:\\ProgramData\\gemini-cli':'/etc/gemini-cli';
  if([p.join(root,'settings.json'),env.GEMINI_CLI_SYSTEM_SETTINGS_PATH].filter(Boolean).some(file=>fs.existsSync(file)))return true;
  try{return fs.readdirSync(p.join(root,'policies')).some(name=>name.endsWith('.toml'));}catch{return false;}
}
function readPackage(entry){
  let real;try{real=fs.realpathSync(entry);}catch{return null;}
  let directory=path.dirname(real);
  for(let n=0;n<8;n++){
    try{const file=path.join(directory,'package.json');if(fs.statSync(file).size<512*1024){const pkg=JSON.parse(fs.readFileSync(file,'utf8'));
      const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.gemini;
      if(pkg.name==='@google/gemini-cli'&&typeof bin==='string'&&path.resolve(directory,bin)===real)return {entry:real,version:text(pkg.version)};
    }}catch{}
    const parent=path.dirname(directory);if(parent===directory)break;directory=parent;
  }
  return null;
}
function nativeCLI(file){
  try{const real=fs.realpathSync(file);if(!/^(?:agy|antigravity)(?:\.exe)?$/i.test(path.basename(real)))return null;
    const fd=fs.openSync(real,'r'),header=Buffer.alloc(4);try{fs.readSync(fd,header,0,4,0);}finally{fs.closeSync(fd);}
    const magic=header.toString('hex');return ['cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca','7f454c46'].includes(magic)||header.subarray(0,2).toString()==='MZ'?real:null;
  }catch{return null;}
}
function cleanMessage(value){
  return text(value).replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/gi,'$1[redacted]').slice(0,2000);
}
function commandRunner(invocation,{timeout=10000,maxBuffer=1024*1024}={}){
  try{return spawnSync(invocation.command,invocation.args,{cwd:invocation.cwd,env:invocation.env,shell:false,windowsHide:true,encoding:'utf8',timeout,maxBuffer,stdio:['ignore','pipe','pipe']});}
  catch{return {status:null,stdout:'',stderr:''};}
}
function inspect(executable,args,{env,nodePath,platform,runner,home,deadline=Date.now()+15000}){
  const timeout=Math.min(5000,deadline-Date.now());if(timeout<100)return null;
  try{const invocation=resolveCLIInvocation({executable,args,env,nodePath,platform});
    const result=runner({...invocation,cwd:home},{timeout,maxBuffer:1024*1024});
    if(!result||result.error||result.signal)return null;
    return {status:result.status,stdout:text(result.stdout),stderr:text(result.stderr)};
  }catch{return null;}
}
function parsedJSON(raw){try{return JSON.parse(raw);}catch{return null;}}
function authStatus(result){
  if(!result||result.status!==0)return false;
  const value=parsedJSON(result.stdout),row=value?.auth||value;
  if(row&&typeof row==='object'&&!Array.isArray(row)){
    if(row.authenticated===true||row.loggedIn===true||row.logged_in===true)return true;
    if(row.authenticated===false||row.loggedIn===false||row.logged_in===false)return false;
    if(['authenticated','signed-in','logged-in'].includes(row.status))return true;
  }
  const output=result.stdout;
  if(/not (?:logged|signed) in|unauthenticated|authentication required|login required|expired|revoked|eligibility.*fail/i.test(output))return false;
  return /(?:^|\n)\s*(?:[✓✔]\s*)?(?:authenticated\s*:\s*true|logged in(?:\s+as|\s*$)|signed in(?:\s+as|\s*$)|authentication(?:\s+status)?\s*:\s*(?:authenticated|success))/im.test(output);
}
function parseModels(raw){
  const parsed=parsedJSON(raw);let rows=Array.isArray(parsed)?parsed:Array.isArray(parsed?.models)?parsed.models:null;
  if(!rows)rows=raw.split(/\r?\n/).map(line=>{const match=/^([a-z0-9][a-z0-9._/-]*)\s{2,}(.+)$/i.exec(line.trim());return match?{id:match[1],name:match[2]}:null;}).filter(Boolean);
  const seen=new Set();return rows.flatMap(row=>{
    if(typeof row==='string')row={id:row};
    const modelId=row?.id||row?.slug||row?.model_id;if(!id(modelId)||seen.has(modelId))return [];seen.add(modelId);
    const allowed=row.availableEfforts||row.available_efforts||row.efforts||row.reasoning_efforts;
    const efforts=['default',...new Set((Array.isArray(allowed)?allowed:[]).filter(value=>['low','medium','high','xhigh','max'].includes(value)))];
    return [{id:modelId,label:(text(row.display_name)||text(row.displayName)||text(row.label)||text(row.name)||modelId).slice(0,200),efforts,ready:false,availability:'catalog-observed',source:{kind:'official-cli-catalog'}}];
  }).slice(0,200);
}
function supportsReadonlyReports(version){const match=/\b(\d+)\.(\d+)\.(\d+)\b/.exec(version||'');if(!match)return false;const [major,minor,patch]=match.slice(1).map(Number);return major>1||major===1&&(minor>1||minor===1&&patch>=12);}
function confirmedQuota(result){
  if(!result||result.status!==0)return false;
  const value=parsedJSON(result.stdout);if(!value||typeof value!=='object'||value.error||['ERROR','CANCELED','INTERRUPTED','INVALID'].includes(value.status))return false;
  // Accept only account-specific quota numbers, never generic model names,
  // usage token counters, identity strings, or a successful local command.
  function hasQuota(row,depth=0,inQuota=false){
    if(!row||typeof row!=='object'||depth>6)return false;
    if(Array.isArray(row))return row.some(item=>hasQuota(item,depth+1,inQuota));
    for(const [key,item] of Object.entries(row)){
      const quota=inQuota||/quota/i.test(key);
      if((quota&&/remaining|fraction|percent|limit|used/i.test(key)||/^remaining[_-]?(?:fraction|percent|requests|tokens)$/i.test(key))&&number(item)!==null)return true;
      if(item&&typeof item==='object'&&hasQuota(item,depth+1,quota))return true;
    }
    return false;
  }
  return hasQuota(value);
}
function findApplication(applications,pattern){
  return (Array.isArray(applications)?applications:[]).find(row=>pattern.test(typeof row==='string'?row:`${row?.name||''} ${row?.appPath||''} ${row?.path||''}`));
}
function appPath(row){return typeof row==='string'?row:row?.appPath||row?.path||null;}
function base(id,name,application){return {id,name,installed:!!application,appPath:appPath(application),mode:'handoff',ready:false,executable:null,
  cliAvailable:false,authStatus:application?'client-managed':'unknown',adapterStatus:'unavailable',models:[],efforts:['default'],capabilities:{execute:false,readOnly:false,probe:false},
  readinessReason:{code:application?'adapter-unavailable':'cli-missing',message:application?'原应用账号由客户端管理；未检测到官方独立执行 CLI，不代表原应用未登录。':'未检测到官方 CLI。'},
  message:application?'已发现原应用；需要官方独立 CLI 后才能验证自动执行。':'未检测到官方 CLI。'};}

function detectGoogleProviders({home=os.homedir(),platform=process.platform,env=process.env,nodePath=process.execPath,applications=[],runner=commandRunner,findCLI:finder=findCLI}={}){
  const p=platform==='win32'?path.win32:path;
  const lookup=(name,extra)=>finder(name,{home,platform,env,extra});
  const options={home,platform,env:googleEnvironment('gemini',env),nodePath,runner,deadline:Date.now()+15000};
  const gemini=base('gemini','Gemini CLI',findApplication(applications,/gemini/i));
  const agy=base('antigravity','Antigravity',findApplication(applications,/antigravity/i));
  const geminiPath=lookup('gemini',[p.join(home,'.local','bin',platform==='win32'?'gemini.cmd':'gemini'),...(platform==='darwin'?['/opt/homebrew/bin/gemini','/usr/local/bin/gemini']:[])]);
  const metadata=geminiPath&&readPackage(geminiPath);
  if(metadata){
    const help=inspect(metadata.entry,['--help'],options);
    if(help?.status===0&&/--output-format/.test(help.stdout)&&/--prompt/.test(help.stdout)){
      const configured=geminiConfigured({home,env,platform});
      const safeProbe=supportedProbeVersion(metadata.version)&&/--policy\b/.test(help.stdout)&&/--admin-policy\b/.test(help.stdout)&&/--approval-mode\b/.test(help.stdout)&&/\bplan\b/.test(help.stdout)&&!systemGeminiPolicies(platform,env);
      Object.assign(gemini,{installed:true,mode:'cli',cliAvailable:true,executable:metadata.entry,version:metadata.version,nodePath,platform,
        authStatus:configured.configured?'configured':'required',adapterStatus:'available',origin:'gemini-official-cli',
        capabilities:{execute:true,readOnly:/--approval-mode/.test(help.stdout)&&/\bplan\b/.test(help.stdout),probe:safeProbe},
        models:[{id:'default',label:'跟随 Gemini CLI',efforts:['default'],ready:false,availability:'authentication-unverified',source:{kind:'cli-default'}}],
        readinessReason:{code:configured.configured?'authentication-unverified':'authentication-required',message:configured.configured?'检测到官方登录配置；请验证默认模型后使用。':'请先在官方 Gemini CLI 完成登录或配置 API。'},
        message:configured.configured?'已检测官方登录配置；尚未验证模型执行。个人 Google 免费、Pro、Ultra 账号已迁移到 Antigravity CLI。':'已发现官方 Gemini CLI；请登录或配置 API，旧个人账号可使用 Antigravity CLI。'});
      if(!supportedProbeVersion(metadata.version))gemini.message+=' 此版本安全探针尚未核验，请使用已验证的官方 0.64.x 稳定版。';
    }
  }
  const agyPath=lookup('agy',[p.join(home,'.local','bin',platform==='win32'?'agy.exe':'agy'),...(platform==='win32'?[p.join(env.LOCALAPPDATA||p.join(home,'AppData','Local'),'agy','bin','agy.exe')]:[])]);
  const executable=agyPath&&nativeCLI(agyPath);
  if(executable){
    const agyOptions={...options,env:googleEnvironment('antigravity',env)};
    const help=inspect(executable,['--help'],agyOptions);
    if(help?.status===0&&/antigravity/i.test(help.stdout)&&/--(?:print|prompt)/.test(help.stdout)&&/--output-format/.test(help.stdout)){
      Object.assign(agy,{installed:true,mode:'cli',cliAvailable:true,executable,platform,origin:'antigravity-official-cli',adapterStatus:'available',authStatus:'unknown',
        capabilities:{execute:/--input-format/.test(help.stdout),readOnly:/--mode/.test(help.stdout)&&/\bplan\b/.test(help.stdout),probe:false},
        readinessReason:{code:'authentication-unverified',message:'官方 CLI 已发现；需要其自身账号状态和模型目录均成功才能启用。'},message:'复用由官方 CLI 自行读取的既有系统钥匙串授权；未读取或复制令牌。'});
      // Never turn an unknown positional command into an agent prompt. Inspect
      // the help tree before issuing a status subcommand.
      const authHelp=/^\s+auth\s/m.test(help.stdout)?inspect(executable,['auth','--help'],agyOptions):null;
      const status=authHelp?.status===0&&/^\s+status\s/m.test(authHelp.stdout)?inspect(executable,['auth','status'],agyOptions):null;
      let authenticated=authStatus(status),quotaStatus=null;
      if(!authenticated&&!status){
        const version=inspect(executable,['--version'],agyOptions);agy.version=version?.status===0?(version.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0]||''):'';
        if(supportsReadonlyReports(agy.version)){
          const reportHelp=inspect(executable,['-p','/help','--output-format','json'],agyOptions);
          if(reportHelp?.status===0&&/(?:\/usage|"usage")/.test(reportHelp.stdout)){
            quotaStatus=inspect(executable,['-p','/usage','--output-format','json'],agyOptions);authenticated=confirmedQuota(quotaStatus);
          }
        }
      }
      const catalog=/^\s+models\s/m.test(help.stdout)?inspect(executable,['models','--output-format','json'],agyOptions):null;
      const models=catalog?.status===0?parseModels(catalog.stdout):[];
      const quotaNeedsLogin=quotaStatus&&/authentication required|not (?:logged|signed) in|unauthenticated/i.test(quotaStatus.stdout+'\n'+quotaStatus.stderr);
      agy.authStatus=authenticated?'configured':status||quotaNeedsLogin?'required':'unknown';
      agy.models=models.length?models:[{id:'default',label:'跟随 Antigravity CLI',efforts:['default'],ready:false,availability:'unknown-catalog',source:{kind:'cli-default'}}];
      agy.ready=authenticated&&models.length>0&&agy.capabilities.execute&&agy.capabilities.readOnly;
      if(agy.ready){agy.models=agy.models.map(row=>({...row,ready:true,availability:'authenticated-cli-catalog'}));agy.readinessReason={code:'cli-authenticated',message:'官方 CLI 已确认既有授权及模型目录。'};}
      else if(status&&!authenticated){agy.readinessReason={code:'authentication-required',message:'官方 CLI 尚未确认可用授权，请在官方 CLI 完成登录。'};}
      else if(authenticated&&!models.length){agy.readinessReason={code:'catalog-unavailable',message:'已确认 CLI 授权，模型目录尚未返回。'};}
      agy.message=agy.readinessReason.message;
    }
  }
  return [gemini,agy];
}
function describeGoogleAuth(provider){
  if(!['gemini','antigravity'].includes(provider?.id))return null;
  const available=provider.mode==='cli'&&provider.cliAvailable===true&&!!provider.executable;
  return {kind:available?'browser-cli':provider.appPath?'desktop':'none',label:available?'打开终端登录':provider.appPath?'打开原应用':'未检测到 CLI',
    canStart:available||!!provider.appPath,state:provider.ready?'verified':available?'unverified':'unavailable',executionReady:provider.ready===true,browserFlow:false,
    requiresTerminal:available,credentialOwner:provider.id==='gemini'?'Gemini CLI':'Antigravity CLI',message:'由官方 CLI 交互界面处理登录；AgentFlow 不读取、复制或导出凭据。'};
}
function googleAuthInvocation(provider,{nodePath=process.execPath,env=process.env,platform=provider?.platform||process.platform}={}){
  if(!describeGoogleAuth(provider)?.canStart||provider.mode!=='cli')throw new Error('未检测到官方 Google CLI 登录入口。');
  if(provider.id==='gemini'&&!readPackage(provider.executable)||provider.id==='antigravity'&&!nativeCLI(provider.executable))throw new Error('官方 CLI 入口验证失败。');
  // These official login surfaces are TUIs, not invented `auth login` flags.
  return {...resolveCLIInvocation({executable:provider.executable,args:[],nodePath,env:googleEnvironment(provider.id,env),platform}),requiresTerminal:true,interactive:true};
}
function buildGoogleInvocation({provider,stage={},prompt,workspace,env=process.env,nodePath=provider?.nodePath||process.execPath}={}){
  if(!['gemini','antigravity'].includes(provider?.id)||provider.mode!=='cli'||!provider.executable)throw new Error('没有官方 Google CLI 执行入口。');
  const probe=stage.probe===true;
  if(probe&&(provider.id!=='gemini'||provider.capabilities?.probe!==true))throw new Error('此 Google CLI 版本尚无经过验证的全面禁工具连接探针。');
  if(!provider.ready&&!probe)throw new Error('Google CLI 授权和模型执行目录尚未确认。');
  if(probe)prompt='Reply exactly OK. Do not use any tools.';
  if(typeof prompt!=='string'||!prompt.trim()||prompt.includes('\0'))throw new Error('任务内容无效。');
  const platform=provider.platform||process.platform,p=platform==='win32'?path.win32:path;
  if(typeof workspace!=='string'||!p.isAbsolute(workspace)||/[\u0000-\u001f]/.test(workspace))throw new Error('工作区必须是绝对路径。');
  const selected=text(stage.model),modelId=selected&&selected!=='default'?selected:null;
  const model=provider.models?.find(row=>row.id===(modelId||'default'));
  if(modelId&&(!id(modelId)||!model?.ready))throw new Error('所选模型尚未从官方授权目录确认。');
  const effort=stage.effort||'default';if(!(model?.efforts||['default']).includes(effort))throw new Error('所选模型未声明该思考强度。');
  const readOnly=probe||['plan','review','acceptance','规划','验收'].includes(stage.role||stage.kind||stage.id)||stage.readOnly===true;
  if(readOnly&&!provider.capabilities?.readOnly)throw new Error('此版本 CLI 尚未确认只读模式。');
  const environment=googleEnvironment(provider.id,env);let args,stdin=prompt,temporaryDirectory=null,runWorkspace=workspace;
  if(provider.id==='gemini'){
    const metadata=readPackage(provider.executable);
    if(!metadata)throw new Error('官方 Gemini npm 包入口验证失败。');
    if(probe&&!supportedProbeVersion(metadata.version))throw new Error('Gemini CLI 版本已变化，请重新检测；当前版本的安全探针尚未核验。');
    args=['--output-format','stream-json','--approval-mode',readOnly?'plan':'auto_edit'];
    if(modelId)args.push('--model',modelId);
    if(effort!=='default')throw new Error('Gemini CLI 未提供已验证的逐次思考强度参数。');
    if(probe){
      if(systemGeminiPolicies(platform,environment))throw new Error('存在系统管理的 Gemini 设置或策略；无法保证临时禁工具探针覆盖全部配置，请使用官方 CLI 验证。');
      temporaryDirectory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-gemini-probe-')));fs.chmodSync(temporaryDirectory,0o700);
      const configDirectory=path.join(temporaryDirectory,'.gemini');fs.mkdirSync(configDirectory,{mode:0o700});
      const policyFile=path.join(temporaryDirectory,'deny-tools.toml');
      fs.writeFileSync(policyFile,'[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n',{mode:0o600,flag:'wx'});
      fs.writeFileSync(path.join(configDirectory,'settings.json'),JSON.stringify({hooksConfig:{enabled:false},admin:{extensions:{enabled:false},mcp:{enabled:false},skills:{enabled:false}},skills:{enabled:false},tools:{exclude:['*'],discoveryCommand:'',callCommand:'',sandbox:false},mcp:{serverCommand:''},context:{fileName:[]},model:{maxSessionTurns:1},general:{enableAutoUpdate:false},telemetry:{enabled:false}}),{mode:0o600,flag:'wx'});
      // Trust only this generated, private probe workspace so its restrictive
      // settings override user hooks. The original HOME/auth store is retained.
      environment.GEMINI_CLI_TRUST_WORKSPACE='true';runWorkspace=temporaryDirectory;
      args.push('--policy',policyFile,'--admin-policy',policyFile);
    }
    // An empty -p activates headless mode; the actual prompt stays on stdin.
    args.push('--prompt','');
  }else{
    if(!nativeCLI(provider.executable))throw new Error('官方 Antigravity 原生入口验证失败。');
    args=['--input-format','stream-json','--output-format','stream-json','--mode',readOnly?'plan':'default'];
    if(modelId)args.push('--model',modelId);if(effort!=='default')args.push('--effort',effort);
    stdin=JSON.stringify({event:'user',message:{content:prompt}})+'\n';
  }
  const cleanup=()=>{if(temporaryDirectory){fs.rmSync(temporaryDirectory,{recursive:true,force:true});temporaryDirectory=null;}};
  try{return {...resolveCLIInvocation({executable:provider.executable,args,env:environment,nodePath,platform}),stdin,cwd:runWorkspace,protocol:provider.id,selection:{modelId,effort},cleanup};}
  catch(error){cleanup();throw error;}
}
function geminiUsage(stats){
  if(!stats||typeof stats!=='object')return undefined;
  const usage=emptyUsage();
  if('input_tokens'in stats||'output_tokens'in stats){usage.input=number(stats.input_tokens);usage.output=number(stats.output_tokens);usage.cacheRead=number(stats.cached);return usage;}
  const rows=Object.values(stats.models||{}).map(row=>row?.tokens).filter(Boolean);
  if(!rows.length)return undefined;
  for(const [field,key] of [['input','prompt'],['output','candidates'],['cacheRead','cached'],['reasoning','thoughts']]){
    const values=rows.map(row=>number(row[key]));usage[field]=values.every(value=>value!==null)?values.reduce((a,b)=>a+b,0):null;
  }
  return usage;
}
function parseGoogleEvent(value,providerId){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  if(providerId==='antigravity'){
    if(value.event==='init')return {sessionId:text(value.conversation_id)||undefined,modelId:text(value.init?.model)||undefined};
    if(value.event==='step_update'){
      const step=value.step_update||{};
      if(step.step_type==='agent_response')return {sessionId:text(step.conversation_id)||undefined,text:text(step.text_delta),appendText:true,messageId:Number.isSafeInteger(step.step_index)?String(step.step_index):undefined};
      if(step.step_type==='tool')return {activity:text(step.tool_name)||'工具调用'};
      return {};
    }
    const result=value.event==='result'?value.result:typeof value.status==='string'&&('response'in value||'error'in value)?value:null;
    if(!result||typeof result!=='object')return {};
    const usage=result.usage?{input:number(result.usage.input_tokens),output:number(result.usage.output_tokens),cacheRead:number(result.usage.cache_read_tokens),cacheWrite:null,reasoning:number(result.usage.thinking_tokens),costUSD:null}:undefined;
    const success=result.status==='SUCCESS';
    return {sessionId:text(result.conversation_id)||undefined,text:text(result.response),appendText:false,usage,terminal:true,success,error:success?undefined:cleanMessage(result.error||`Antigravity 未成功完成：${text(result.status)||'未知状态'}`)};
  }
  if(providerId==='gemini'){
    if(value.type==='init')return {sessionId:text(value.session_id)||undefined,modelId:text(value.model)||undefined};
    if(value.type==='message'&&value.role==='assistant')return {text:text(value.content),appendText:value.delta===true};
    if(value.type==='tool_use')return {activity:text(value.tool_name)||'工具调用'};
    if(value.type==='error')return value.severity==='warning'?{activity:cleanMessage(value.message)}:{error:cleanMessage(value.message)};
    if(value.type==='result')return {usage:geminiUsage(value.stats),terminal:true,success:value.status==='success',error:value.status==='success'?undefined:cleanMessage(value.error?.message||'Gemini 未成功完成。')};
    if('response'in value||value.error)return {sessionId:text(value.session_id)||undefined,text:text(value.response),appendText:false,usage:geminiUsage(value.stats),terminal:true,success:!value.error,error:value.error?cleanMessage(value.error.message||value.error):undefined};
  }
  return {};
}
module.exports={detectGoogleProviders,buildGoogleInvocation,parseGoogleEvent,googleAuthInvocation,describeGoogleAuth};

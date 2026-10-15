'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {windowsApplicationRoots,cliSearchDirectories}=require('./runtime.cjs');
const AGENT_PATTERN=/(?:^|[ ._-])(?:ai|agent|assistant|jan)(?:$|[ ._-])|codex|claude|codebuddy|workbuddy|deepseek|marvis|doubao|cursor|windsurf|copilot|antigravity|opencode|openclaw|gemini|chatgpt|mistral|le\s*chat|trae|qoder|kiro|aider|goose|manus|cline|augment|lm studio|ollama|chatbox|cherry studio|chatwise|智谱|豆包|千问|通义|智能|助手|反重力/i;
const SKIP_DIRECTORIES=/^(?:node_modules|vendor|Library|Contents|resources|app\.asar\.unpacked|Caches?|logs?|__MACOSX|\.git|Accounts?|Auth|Credentials?|Secrets?|Sessions?|Profiles?|User Data|Cookies|storage)$/i;
const GOOGLE_CLIS=[{name:'gemini',id:'gemini',label:'Google Gemini CLI',adapter:'gemini-cli'},
  {name:'agy',id:'antigravity',label:'Google Antigravity CLI',adapter:'antigravity-cli'},
  {name:'antigravity',id:'antigravity-launcher',label:'Google Antigravity IDE 启动器',adapter:'antigravity-launcher'}];
const metadataCache=new Map();
function canonical(file,platform){
  let resolved;try{resolved=fs.realpathSync(file);}catch{resolved=path.resolve(file);}
  return platform==='win32'?resolved.toLowerCase():resolved;
}
function executionTrustForRoot(root,{home,platform}){
  // Keep the scan origin before resolving any bundle link. A link discovered
  // in Downloads must not inherit trust from its target in another directory.
  const normalize=file=>platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
  const relative=path.relative(normalize(path.join(home,'Downloads')),normalize(root));
  return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)?'untrusted-discovery':'installed-location';
}
function applicationRoots({home,roots,platform,env}){
  if(roots!==undefined)return roots;
  if(platform==='win32'){
    const local=env.LOCALAPPDATA||path.join(home,'AppData','Local');
    // Public installation folders only: never walk the whole AppData tree.
    const direct=['Antigravity','Google/Antigravity','Gemini','Google/Gemini','Cursor','Windsurf','Trae','Qoder','Kiro','OpenCode','Claude','WorkBuddy','CodeBuddy'];
    // runtime also exposes LOCALAPPDATA for exact known-product lookups. A generic
    // recursive scanner must not treat that account-data root as an install tree.
    const installRoots=windowsApplicationRoots({home,env}).filter(root=>canonical(root,'win32')!==canonical(local,'win32'));
    return [...new Set([...installRoots,env['PROGRAMFILES(X86)'],
      ...direct.map(name=>path.join(local,...name.split('/')))].filter(Boolean))];
  }
  return ['/Applications',path.join(home,'Applications'),path.join(home,'Downloads')];
}
function scanApplications(root,platform){
  const apps=[],directories=[];let visited=0;const seen=new Set();
  function walk(folder,depth){
    const identity=canonical(folder,platform);if(seen.has(identity)||visited>=4000)return;seen.add(identity);
    let entries;try{entries=fs.readdirSync(folder,{withFileTypes:true});directories.push(folder);}catch{return;}
    // Find bundles at this level before spending the bounded budget on subfolders.
    entries.sort((a,b)=>Number(/\.app$/i.test(b.name))-Number(/\.app$/i.test(a.name))||a.name.localeCompare(b.name));
    const nested=[];
    for(const e of entries){
      if(++visited>4000||apps.length>=256)return;
      const file=path.join(folder,e.name);
      if(platform==='win32'&&e.isFile()&&/\.exe$/i.test(e.name)&&AGENT_PATTERN.test(e.name)&&!/uninstall|update|crash|helper|setup/i.test(e.name)){apps.push(file);continue;}
      if(/\.app$/i.test(e.name)){
        try{if((e.isDirectory()||e.isSymbolicLink())&&fs.statSync(file).isDirectory())apps.push(fs.realpathSync(file));}catch{}
        continue;
      }
      // Bundle links are supported, arbitrary folder links/junctions are not followed.
      if(e.isDirectory()&&!e.isSymbolicLink()&&depth<3&&!e.name.startsWith('.')&&!SKIP_DIRECTORIES.test(e.name))nested.push(file);
    }
    for(const child of nested)walk(child,depth+1);
  }
  walk(root,0);return {apps,directories};
}
function appMetadata(appPath){
  const file=path.join(appPath,'Contents/Info.plist');let st;try{st=fs.statSync(file);if(st.size>1024*1024)return null;}catch{return null;}
  const key=st.size+':'+st.mtimeMs;const old=metadataCache.get(file);if(old?.key===key)return old.value;
  const result=spawnSync('/usr/bin/plutil',['-convert','json','-o','-',file],{encoding:'utf8',shell:false,timeout:1500,maxBuffer:1024*1024});
  let value=null;try{if(result.status===0){const p=JSON.parse(result.stdout);value={name:String(p.CFBundleDisplayName||p.CFBundleName||path.basename(appPath,'.app')),bundleId:String(p.CFBundleIdentifier||''),version:String(p.CFBundleShortVersionString||'')};}}catch{}
  if(metadataCache.size>=512)metadataCache.delete(metadataCache.keys().next().value);
  metadataCache.set(file,{key,value});return value;
}
function cliDirectories({home,env,platform,cliRoots,roots}){
  if(cliRoots!==undefined)return cliRoots;
  // Explicit app roots isolate custom scans and fixtures from the host PATH.
  if(roots!==undefined)return [];
  return cliSearchDirectories({home,env,platform});
}
function cliEntries(options){
  const entries=[];
  for(const directory of cliDirectories(options))for(const cli of GOOGLE_CLIS){
    const names=options.platform==='win32'?[cli.name+'.exe',cli.name+'.cmd',cli.name+'.com',cli.name]:[cli.name];
    for(const name of names){const executable=path.join(directory,name);try{
      if(!fs.statSync(executable).isFile())continue;
      if(options.platform!=='win32')fs.accessSync(executable,fs.constants.X_OK);
      // Discovery only: never execute or interpret an npm .cmd shim.
      if(!entries.some(p=>p.id===cli.id))entries.push({...cli,executable});
      break;
    }catch{}}
  }
  return entries;
}
function handoffFields(message){return {installed:true,ready:false,mode:'handoff',
  models:[{id:'',label:'原应用管理模型',ready:false,availability:'adapter-unavailable',efforts:['default']}],efforts:['default'],
  authStatus:'client-managed',adapterStatus:'unavailable',readinessReason:{code:'adapter-unavailable',message},message};}
function discoverApplications({home=os.homedir(),knownProviders=[],roots,cliRoots,platform=process.platform,env=process.env,readAppMetadata=appMetadata}={}){
  const options={home,roots,cliRoots,platform,env};
  const knownPaths=new Set(knownProviders.map(p=>p.appPath).filter(Boolean).map(p=>canonical(p,platform)));
  const knownBundles=new Set(platform==='darwin'?knownProviders.map(p=>p.appPath?readAppMetadata(p.appPath)?.bundleId:null).filter(Boolean):[]);
  const results=[],seenPaths=new Set();
  for(const root of applicationRoots(options))for(const appPath of scanApplications(root,platform).apps){
    const executionTrust=executionTrustForRoot(root,options);
    const identity=canonical(appPath,platform);if(knownPaths.has(identity)||seenPaths.has(identity))continue;seenPaths.add(identity);
    const filename=path.basename(appPath).replace(platform==='win32'?/\.exe$/i:/\.app$/i,'');
    if(/^AgentFlow(?:$|[ ._-])/i.test(filename))continue;
    // Renamed or localized apps are recognized by their public product metadata.
    const meta=platform==='win32'?{name:filename,bundleId:'',version:''}:readAppMetadata(appPath);
    if(!meta||!AGENT_PATTERN.test(filename+' '+meta.name+' '+meta.bundleId)||(meta.bundleId&&knownBundles.has(meta.bundleId))||meta.bundleId==='cn.liuli.agentflow')continue;
    const id='app-'+crypto.createHash('sha256').update(meta.bundleId||identity).digest('hex').slice(0,20);
    if(results.some(p=>p.id===id))continue;
    const displayName=String(meta.name)+(String(meta.bundleId||'').startsWith('com.apple.Safari.WebApp')?' 网页版':'');
    results.push({id,name:displayName.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,100),appPath,version:meta.version,bundleId:meta.bundleId,discovered:true,executionTrust,
      ...handoffFields('已发现原应用，账号由原应用管理；工作台尚无经过验证的任务执行和结果接口。'),discoverySource:'applications'});
  }
  for(const cli of cliEntries(options)){
    if(knownProviders.some(p=>p.id===cli.id||(p.executable&&canonical(p.executable,platform)===canonical(cli.executable,platform))))continue;
    const app=cli.name==='antigravity'?results.find(p=>p.appPath&&/antigravity|反重力/i.test(p.name+' '+p.bundleId)):null;
    if(app){app.cliLaunchers=[{name:cli.name,executable:cli.executable}];continue;}
    results.push({id:cli.id,name:cli.label,appPath:null,executable:cli.executable,cliName:cli.name,suggestedAdapter:cli.adapter,discovered:true,
      ...handoffFields('已发现命令行入口；账号状态与独立任务执行接口尚未验证，不能仅凭安装文件启用。'),discoverySource:'command-path'});
  }
  return results;
}
function discoveryFingerprint({home=os.homedir(),roots,cliRoots,platform=process.platform,env=process.env}={}){
  const options={home,roots,cliRoots,platform,env},paths=[];
  for(const root of applicationRoots(options)){
    paths.push(root);const scan=scanApplications(root,platform);paths.push(...scan.directories);
    for(const app of scan.apps)paths.push(platform==='darwin'?path.join(app,'Contents','Info.plist'):app);
  }
  const configuredGemini=typeof env.GEMINI_CLI_HOME==='string'&&path.isAbsolute(env.GEMINI_CLI_HOME)?env.GEMINI_CLI_HOME:home;
  paths.push(...cliDirectories(options),...cliEntries(options).map(p=>p.executable),path.join(configuredGemini,'.gemini','settings.json'),path.join(configuredGemini,'.gemini','oauth_creds.json'),path.join(home,'.codex/models_cache.json'),path.join(home,'.dsh/profiles/desktop/agent-default-model.yaml'));
  return [...new Set(paths)].map(p=>{try{const s=fs.statSync(p);return p+':'+s.mtimeMs+':'+s.size;}catch{return p+':missing';}}).join('|');
}
class DiscoveryWatcher{
  constructor({onChange,intervalMs=4000,home=os.homedir(),roots,cliRoots,platform=process.platform,env=process.env}){this.onChange=onChange;this.intervalMs=intervalMs;this.home=home;this.location={home,roots,cliRoots,platform,env};this.timer=null;this.busy=false;this.fingerprint='';this.lastRefresh=0;}
  start(){this.fingerprint=discoveryFingerprint(this.location);this.lastRefresh=Date.now();this.timer=setInterval(()=>this.check(),this.intervalMs);this.timer.unref();}
  async check(){if(this.busy)return;const fingerprint=discoveryFingerprint(this.location);if(fingerprint===this.fingerprint&&Date.now()-this.lastRefresh<60000)return;
    this.busy=true;this.fingerprint=fingerprint;this.lastRefresh=Date.now();try{await this.onChange();}catch{}finally{this.busy=false;}}
  stop(){clearInterval(this.timer);}
}
module.exports={discoverApplications,discoveryFingerprint,DiscoveryWatcher};

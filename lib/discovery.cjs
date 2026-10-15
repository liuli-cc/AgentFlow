'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {windowsApplicationRoots}=require('./runtime.cjs');
const AGENT_PATTERN=/(?:^|[ ._-])(?:ai|agent|assistant|jan)(?:$|[ ._-])|codex|claude|codebuddy|workbuddy|deepseek|marvis|doubao|cursor|windsurf|copilot|antigravity|opencode|openclaw|gemini|chatgpt|mistral|le\s*chat|trae|qoder|kiro|aider|goose|manus|cline|augment|lm studio|ollama|chatbox|cherry studio|chatwise|智谱|豆包|千问|通义|智能|助手/i;
const metadataCache=new Map();
function appsIn(root,platform=process.platform){
  const found=[];let visited=0;
  function walk(folder,depth){let entries;try{entries=fs.readdirSync(folder,{withFileTypes:true});}catch{return;}
    for(const e of entries){if(++visited>1500)return;
      const name=path.join(folder,e.name);
      if(platform==='win32'&&e.isFile()&&/\.exe$/i.test(e.name)&&AGENT_PATTERN.test(e.name)&&!/uninstall|update|crash|helper|setup/i.test(e.name)){found.push(name);continue;}
      if(e.isSymbolicLink()){try{if(e.name.endsWith('.app')&&fs.statSync(name).isDirectory())found.push(fs.realpathSync(name));}catch{}continue;}
      if(e.isDirectory()&&e.name.endsWith('.app')){found.push(name);continue;}
      if(e.isDirectory()&&depth<(platform==='win32'?2:1)&&!e.name.startsWith('.'))walk(name,depth+1);
    }
  }walk(root,0);return found;
}
function appMetadata(appPath){
  const file=path.join(appPath,'Contents/Info.plist');let st;try{st=fs.statSync(file);if(st.size>1024*1024)return null;}catch{return null;}
  const key=st.size+':'+st.mtimeMs;const old=metadataCache.get(file);if(old?.key===key)return old.value;
  const result=spawnSync('/usr/bin/plutil',['-convert','json','-o','-',file],{encoding:'utf8',shell:false,timeout:1500,maxBuffer:1024*1024});
  let value=null;try{if(result.status===0){const p=JSON.parse(result.stdout);value={name:String(p.CFBundleDisplayName||p.CFBundleName||path.basename(appPath,'.app')),bundleId:String(p.CFBundleIdentifier||''),version:String(p.CFBundleShortVersionString||'')};}}catch{}
  metadataCache.set(file,{key,value});return value;
}
function discoverApplications({home=os.homedir(),knownProviders=[],roots,platform=process.platform,env=process.env}={}){
  const identity=value=>platform==='win32'?path.resolve(value).toLowerCase():value;
  const knownPaths=new Set(knownProviders.map(p=>p.appPath).filter(Boolean).map(identity));const knownBundles=new Set(platform==='darwin'?[...knownPaths].map(p=>appMetadata(p)?.bundleId).filter(Boolean):[]);const results=[];
  const appRoots=roots??(platform==='win32'?windowsApplicationRoots({home,env}):['/Applications',path.join(home,'Applications')]);
  for(const root of appRoots)for(const appPath of appsIn(root,platform)){
    if(knownPaths.has(identity(appPath))||path.basename(appPath).startsWith('AgentFlow'))continue;
    const filename=path.basename(appPath,platform==='win32'?'.exe':'.app');
    if(!AGENT_PATTERN.test(filename))continue;
    const meta=platform==='win32'?{name:filename,bundleId:'',version:''}:appMetadata(appPath);if(!meta||knownBundles.has(meta.bundleId)||meta.bundleId==='cn.liuli.agentflow')continue;
    const id='app-'+crypto.createHash('sha256').update(meta.bundleId||identity(appPath)).digest('hex').slice(0,20);
    if(results.some(p=>p.id===id))continue;
    const displayName=String(meta.name)+(meta.bundleId.startsWith('com.apple.Safari.WebApp')?' 网页版':'');
    results.push({id,name:displayName.slice(0,100),installed:true,ready:false,mode:'handoff',appPath,version:meta.version,bundleId:meta.bundleId,discovered:true,
      models:[{id:'',label:'原应用管理模型',ready:false,availability:'adapter-unavailable',efforts:['default']}],efforts:['default'],
      authStatus:'client-managed',adapterStatus:'unavailable',readinessReason:{code:'adapter-unavailable',message:'已发现原应用，账号由原应用管理；工作台尚无经过验证的任务执行和结果接口。'},
      message:'已发现原应用，账号由原应用管理；工作台尚无经过验证的任务执行和结果接口。',discoverySource:'applications'});
  }
  return results;
}
function discoveryFingerprint({home=os.homedir(),roots,platform=process.platform,env=process.env}={}){
  const paths=[...(roots??(platform==='win32'?windowsApplicationRoots({home,env}):['/Applications',path.join(home,'Applications')])),path.join(home,'.local/bin'),...(platform==='win32'?[path.join(env.APPDATA||path.join(home,'AppData','Roaming'),'npm')]:['/opt/homebrew/bin']),path.join(home,'.codex/models_cache.json'),path.join(home,'.dsh/profiles/desktop/agent-default-model.yaml')];
  return paths.map(p=>{try{const s=fs.statSync(p);return p+':'+s.mtimeMs+':'+s.size;}catch{return p+':missing';}}).join('|');
}
class DiscoveryWatcher{
  constructor({onChange,intervalMs=4000,home=os.homedir(),roots,platform=process.platform,env=process.env}){this.onChange=onChange;this.intervalMs=intervalMs;this.home=home;this.location={home,roots,platform,env};this.timer=null;this.busy=false;this.fingerprint='';this.lastRefresh=0;}
  start(){this.fingerprint=discoveryFingerprint(this.location);this.lastRefresh=Date.now();this.timer=setInterval(()=>this.check(),this.intervalMs);this.timer.unref();}
  async check(){if(this.busy)return;const fingerprint=discoveryFingerprint(this.location);if(fingerprint===this.fingerprint&&Date.now()-this.lastRefresh<60000)return;
    this.busy=true;this.fingerprint=fingerprint;this.lastRefresh=Date.now();try{await this.onChange();}catch{}finally{this.busy=false;}}
  stop(){clearInterval(this.timer);}
}
module.exports={discoverApplications,discoveryFingerprint,DiscoveryWatcher};

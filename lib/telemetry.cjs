'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {normalizedUsage}=require('./domain.cjs');
const {resolveCLIInvocation}=require('./runtime.cjs');
function modelMetadata(value) {
  if(typeof value!=='string'||value.length>200||!value.trim())return null;
  const text=value.trim();
  if(!/^[\p{L}\p{N} ._:/()+#@·-]+$/u.test(text)||/^(sk[-_]|Bearer )/i.test(text)||/^(未知模型|模型未返回|等待 Codex|等待 Harness)$/.test(text))return null;
  return text;
}
function normalizeObservedModels(raw) {
  if(!Array.isArray(raw))return [];
  const output=[],seen=new Set();
  for(const row of raw.slice(0,128)){
    // Only the helper's observed-model rows are accepted, never a provider catalog.
    if(!row||typeof row!=='object'||row.window!=='today')continue;
    const id=modelMetadata(row.id);if(!id||seen.has(id))continue;seen.add(id);
    const model={id,label:modelMetadata(row.label)||id,window:'today'};
    const route=modelMetadata(row.providerRoute);if(route)model.providerRoute=route;
    if(row.usage&&typeof row.usage==='object')model.usage=normalizedUsage(row.usage);
    output.push(model);if(output.length===64)break;
  }
  return output;
}
function normalizeRecentCalls(raw,{now=Date.now()}={}) {
  if(!Array.isArray(raw))return [];
  const calls=[],seen=new Set();
  for(const row of raw.slice(0,2000)){
    if(!row||typeof row!=='object'||row.scope!=='software'||!['codex','claude','workbuddy','codebuddy','dsh'].includes(row.providerId))continue;
    const modelId=modelMetadata(row.modelId),stamp=typeof row.time==='string'?Date.parse(row.time):NaN;
    if(!modelId||!Number.isFinite(stamp)||stamp>now||stamp<now-7*86400000||typeof row.id!=='string'||!row.id||row.id.length>1000)continue;
    const id=crypto.createHash('sha256').update(row.providerId+'|'+row.id).digest('hex');
    if(seen.has(id))continue;seen.add(id);
    calls.push({id,providerId:row.providerId,modelId,modelLabel:modelMetadata(row.modelLabel)||modelId,
      time:new Date(stamp).toISOString(),scope:'software',source:'本机日志样本',usage:normalizedUsage(row.usage)});
  }
  return calls.sort((a,b)=>b.time.localeCompare(a.time)).slice(0,480);
}
function taskUsageCalls(runs,{metadata}={}) {
  const calls=[];
  for(const run of runs)for(const stage of [...(run.starter?[run.starter]:[]),...run.stages])for(const attempt of stage.attempts??[]){
    // Older attempts did not capture their selection. Never attribute them to a later model switch.
    const captured=metadata?.({runId:run.id,stageId:stage.id,attemptId:attempt.id})||{};
    let modelId=modelMetadata(attempt.actualModelId)||modelMetadata(captured.actualModelId)||modelMetadata(attempt.modelId)||modelMetadata(captured.modelId);
    if(!modelId||modelId==='default')continue;
    const selected=modelMetadata(attempt.modelId)||modelMetadata(captured.modelId);
    if(selected?.includes('::')&&!modelId.includes('::'))modelId=selected.split('::')[0]+'::'+modelId;
    const time=attempt.finishedAt||attempt.startedAt;if(!Number.isFinite(Date.parse(time)))continue;
    calls.push({id:attempt.id,providerId:attempt.providerId||captured.providerId||stage.provider,modelId,modelLabel:modelId,
      time,scope:'task',source:'AgentFlow 实际调用',runId:run.id,stageId:stage.id,attemptId:attempt.id,status:attempt.status,usage:normalizedUsage(attempt.usage)});
  }
  return calls.sort((a,b)=>b.time.localeCompare(a.time)).slice(0,480);
}
class Telemetry {
  constructor({helper,onChange=()=>{},platform=process.platform,home=os.homedir()}) {this.helper=helper;this.onChange=onChange;this.platform=platform;this.home=home;this.child=null;this.timer=null;this.snapshot={recentCalls:[],tokenlens:{installed:this.installed(),softwareSamplesSupported:this.platform==='darwin',status:'等待刷新',updatedAt:null,providers:[]}};}
  installed(){return this.platform==='darwin'&&['/Applications/TokenLens.app',path.join(this.home,'Applications/TokenLens.app')].some(p=>fs.existsSync(p));}
  get(){return this.snapshot;}
  start(){this.refresh();this.timer=setInterval(()=>this.refresh(),60000);this.timer.unref();}
  refresh(){
    if(this.child)return;
    if(this.platform!=='darwin'||!this.helper||!fs.existsSync(this.helper)){
      this.snapshot={recentCalls:[],tokenlens:{installed:this.installed(),softwareSamplesSupported:this.platform==='darwin',status:this.platform!=='darwin'?'当前系统尚不支持软件日志样本；任务用量仍按实际事件统计':'日志读取组件不可用；未显示旧指标',updatedAt:null,providers:[]}};
      this.onChange();return;
    }
    const env={HOME:this.home,PATH:process.env.PATH||'/usr/bin:/bin',LANG:'en_US.UTF-8'};
    for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
    const invocation=resolveCLIInvocation({executable:this.helper,env});
    const child=spawn(invocation.command,invocation.args,{stdio:['ignore','pipe','ignore'],shell:false,env:invocation.env,windowsHide:true});this.child=child;
    let output='',overflow=false;const timeout=setTimeout(()=>child.kill('SIGKILL'),12000);timeout.unref();
    child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(Buffer.byteLength(output)>512000){overflow=true;child.kill('SIGKILL');}});
    let settled=false;const done=code=>{if(settled)return;settled=true;clearTimeout(timeout);this.child=null;try {
      if(code!==0||overflow)throw new Error('timeout');const raw=JSON.parse(output);
      if(raw.schemaVersion!==1||!Array.isArray(raw.providers))throw new Error('schema');
      const providers=raw.providers.filter(p=>['codex','claude','workbuddy','codebuddy','dsh'].includes(p.id)).slice(0,5).map(p=>({id:p.id,name:String(p.name).slice(0,60),scope:'software',partial:true,usage:normalizedUsage(p.usage),models:normalizeObservedModels(p.models)}));
      this.snapshot={recentCalls:normalizeRecentCalls(raw.recentCalls),tokenlens:{installed:this.installed(),softwareSamplesSupported:this.platform==='darwin',status:'已读取 TokenLens 同源日志 · 限量样本',updatedAt:new Date().toISOString(),providers}};
    }catch {this.snapshot={recentCalls:[],tokenlens:{installed:this.installed(),softwareSamplesSupported:this.platform==='darwin',status:'日志读取超时或不可用；未显示旧指标',updatedAt:null,providers:[]}};}
      this.onChange();};
    child.on('error',()=>done(-1));child.on('close',done);
  }
  stop(){clearInterval(this.timer);this.child?.kill('SIGKILL');}
}
module.exports={Telemetry,normalizeObservedModels,normalizeRecentCalls,taskUsageCalls};

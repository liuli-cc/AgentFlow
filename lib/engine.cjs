'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const domain=require('./domain.cjs');
const {version}=require('../package.json');
const {taskUsageCalls}=require('./telemetry.cjs');
const {validateConfig,validateStage,validateWorkspace,redact,aggregateUsage,normalizedUsage,createDefaultConfig,parseVerdict,buildPrompt,EMPTY_USAGE}=domain;
const clone=value=>JSON.parse(JSON.stringify(value));
const iso=()=>new Date().toISOString();
const clipText=(value,limit)=>{
  const bytes=Buffer.from(value,'utf8');if(bytes.length<=limit)return value;
  let end=limit;while(end>0&&(bytes[end]&0xc0)===0x80)end--;
  return bytes.subarray(0,end).toString('utf8');
};
const uid=()=>crypto.randomUUID();
const validId=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/.test(value);
const ACTIVE=new Set(['planning','queued','running','paused','waiting_handoff','cancelling']);
const RECOVER=new Set(['planning','running','cancelling']);
const EXECUTABLE=new Set(['cli','api']);
const stageState=s=>({...s,status:s.enabled===false?'skipped':'pending',text:'',error:null,usage:{...EMPTY_USAGE},attempts:[]});
const mergeUsage=(previous,raw)=>{
  const next=normalizedUsage(raw);const merged={...previous};
  for(const key of ['input','output','cacheRead','cacheWrite','reasoning','costUSD'])if(next[key]!==null)merged[key]=next[key];
  if(raw?.source)merged.source=next.source;
  return normalizedUsage(merged);
};

class Engine {
  constructor({dataDir,detectProviders,runProvider,onChange=()=>{},telemetry=()=>null,conversationStore=null,maxConcurrent=4}){
    this.dataDir=path.resolve(dataDir);this.managedRoot=path.join(this.dataDir,'workspaces');
    this.detectProviders=detectProviders;this.runProvider=runProvider;this.onChange=onChange;this.telemetryReader=telemetry;
    this.conversationStore=conversationStore;
    this.config=createDefaultConfig();this.providers=[];this.runs=[];this.controllers=new Map();this.pumps=new Set();
    this.maxConcurrent=Math.max(1,Math.min(8,Math.floor(Number(maxConcurrent)||4)));this.tick=null;this.dirty=new Set();this.closed=false;this.refreshing=null;
  }
  get activeRunIds(){return this.runs.filter(r=>ACTIVE.has(r.status)).map(r=>r.id);}
  get activeRunId(){return this.activeRunIds[0]??null;}
  async init(){
    fs.mkdirSync(this.dataDir,{recursive:true,mode:0o700});this.dataDir=fs.realpathSync(this.dataDir);
    this.managedRoot=path.join(this.dataDir,'workspaces');
    try{if(fs.lstatSync(this.managedRoot).isSymbolicLink())throw new Error('任务工作区目录不能是符号链接');}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const dir of [this.dataDir,path.join(this.dataDir,'runs'),this.managedRoot]){fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);}
    this.managedRoot=fs.realpathSync(this.managedRoot);
    try{this.config=validateConfig(JSON.parse(fs.readFileSync(path.join(this.dataDir,'config.json'),'utf8')),{requireWorkspace:false});}catch{}
    const files=fs.readdirSync(path.join(this.dataDir,'runs')).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f)).sort((a,b)=>fs.statSync(path.join(this.dataDir,'runs',b)).mtimeMs-fs.statSync(path.join(this.dataDir,'runs',a)).mtimeMs).slice(0,100);
    for(const file of files){try{
      const target=path.join(this.dataDir,'runs',file);if(fs.statSync(target).size>8*1024*1024)continue;
      const run=JSON.parse(fs.readFileSync(target,'utf8'));if(!validId(run.id)||!Array.isArray(run.stages)||!Array.isArray(run.events))continue;
      run.threadId=validId(run.threadId)?run.threadId:run.id;run.title=String(run.title||run.prompt||'新任务').split('\n')[0].slice(0,80);
      if(RECOVER.has(run.status)||run.status==='interrupted'){
        run.status='interrupted';for(const s of [...run.stages,...(run.starter?[run.starter]:[])]){
          if(s.status==='running'){s.status='failed';s.error='任务已中断';}
          for(const a of s.attempts??[])if(a.status==='running'){a.status='interrupted';a.finishedAt=iso();}
        }
      }else if(run.status==='queued'){run.status='paused';}
      this.runs.push(run);
    }catch{}}
    await this.refreshProviders(false);this.emit();return this.getState();
  }
  writePrivate(file,data){const target=path.join(this.dataDir,file);const temp=target+'.'+uid()+'.tmp';fs.writeFileSync(temp,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});fs.renameSync(temp,target);fs.chmodSync(target,0o600);}
  persist(run){this.writePrivate(path.join('runs',run.id+'.json'),run);}
  getState(){
    const runs=this.runs.map(r=>({...r,stages:r.stages.map(s=>({...s,attempts:(s.attempts??[]).map(({text,...a})=>a)})),starter:r.starter?{...r.starter,attempts:(r.starter.attempts??[]).map(({text,...a})=>a)}:null}));
    const telemetry=this.telemetryReader()||{};
    return clone({version,config:this.config,providers:this.providers.map(({executable,env,...p})=>p),runs,activeRunId:this.activeRunId,activeRunIds:this.activeRunIds,telemetry:{...telemetry,recentCalls:[...taskUsageCalls(this.runs,{metadata:ids=>this.conversationStore?.metadata?.(ids)}),...(telemetry.recentCalls??[])]}});
  }
  emit(){this.onChange(this.getState());}
  flush(){clearTimeout(this.tick);this.tick=null;for(const id of this.dirty){const r=this.runs.find(r=>r.id===id);if(r)this.persist(r);}this.dirty.clear();this.emit();}
  notify(run,immediate=false){this.dirty.add(run.id);if(immediate){this.flush();return;}if(!this.tick)this.tick=setTimeout(()=>this.flush(),120);}
  log(run,stage,type,message){run.events.push({time:iso(),stageId:stage?.id??null,type,message:redact(message).slice(0,2000)});if(run.events.length>500)run.events.splice(0,run.events.length-500);}
  async refreshProviders(emit=true){
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{this.providers=await this.detectProviders();if(emit)this.emit();return this.getState();})();
    try{return await this.refreshing;}finally{this.refreshing=null;}
  }
  saveConfig(value){this.config=validateConfig(value,{requireWorkspace:false});this.writePrivate('config.json',this.config);this.emit();return clone(this.config);}
  getRun(id){const run=typeof id==='string'?this.runs.find(r=>r.id===id):null;if(!run)throw new Error('任务不存在');return run;}
  async deleteThread({threadId},trashItem){
    if(!validId(threadId)||typeof trashItem!=='function')throw new Error('对话不存在');
    const removed=this.runs.filter(r=>(r.threadId||r.id)===threadId);
    if(!removed.length)throw new Error('对话不存在');
    if(removed.some(r=>this.controllers.has(r.id)||this.pumps.has(r.id)||['planning','running','queued','cancelling'].includes(r.status)))throw new Error('请先取消正在运行的任务，再删除对话');
    // Remove from lookup before awaiting the OS, preventing resume/confirm races.
    for(const r of removed){this.persist(r);this.dirty.delete(r.id);}
    const records=removed.map(r=>this.conversationStore?.runPath(r.id)).filter(file=>file&&fs.existsSync(file));
    let recovery;
    if(records.length){
      recovery=path.join(this.dataDir,'.delete-'+uid());fs.mkdirSync(recovery,{mode:0o700});
      try{for(const file of records)fs.cpSync(file,path.join(recovery,path.basename(file)),{recursive:true,dereference:false});}
      catch(error){fs.rmSync(recovery,{recursive:true,force:true});throw new Error('对话记录未能备份，已保留原对话');}
    }
    this.runs=this.runs.filter(r=>!removed.includes(r));
    try{for(const r of removed)await trashItem(path.join(this.dataDir,'runs',r.id+'.json'));for(const file of records)await trashItem(file);}
    catch(error){
      this.runs.push(...removed);this.runs.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
      for(const file of records)if(recovery)fs.cpSync(path.join(recovery,path.basename(file)),file,{recursive:true,dereference:false});
      for(const r of removed)this.persist(r);this.emit();throw new Error('删除未完成，已保留对话记录，请重试');
    }finally{if(recovery)fs.rmSync(recovery,{recursive:true,force:true});}
    if(removed.some(r=>r.workspace===this.config.workspace)&&!this.runs.some(r=>r.workspace===this.config.workspace)){
      this.config={...this.config,workspace:''};this.writePrivate('config.json',this.config);
    }
    this.emit();this.drain();return this.getState();
  }
  workspace(raw,id){
    if(raw)return validateWorkspace(raw,{managedRoot:this.managedRoot});
    const folder=path.join(this.managedRoot,id);fs.mkdirSync(folder,{recursive:true,mode:0o700});return validateWorkspace(folder,{managedRoot:this.managedRoot});
  }
  checkWorkspace(run){const canonical=validateWorkspace(run.workspace,{managedRoot:this.managedRoot});if(canonical!==run.workspace)throw new Error('工作目录已被替换，请重新选择');return canonical;}
  stageCapabilities(stage){
    const p=this.providers.find(p=>p.id===stage.provider);if(!p)throw new Error('未发现所选智能体');
    const model=p.models?.find(m=>m.id===stage.model);
    if(stage.model&&stage.model!=='default'&&!model)throw new Error('未发现所选模型，请刷新后重新选择');
    const efforts=model?.efforts?.length?model.efforts:p.efforts??['default'];
    if(stage.effort!=='default'&&!efforts.includes(stage.effort))throw new Error('所选模型不支持这个思考强度');
    return p;
  }
  ready(stage){const p=this.stageCapabilities(stage);const m=p.models?.find(m=>m.id===stage.model);const candidates=p.models??[];return p.ready&&EXECUTABLE.has(p.mode)&&(m?m.ready!==false&&m.availability!=='unavailable':!candidates.length||candidates.some(m=>m.ready!==false&&m.availability!=='unavailable'));}
  availableCatalog(){
    return this.providers.filter(p=>p.ready&&EXECUTABLE.has(p.mode)).map(p=>({id:p.id,name:p.name,models:(p.models??[]).filter(m=>m.ready!==false&&m.availability!=='unavailable').map(m=>({id:m.id,label:m.label,efforts:m.efforts?.length?m.efforts:p.efforts??['default']})),efforts:p.efforts??['default']}));
  }
  contextFor(threadId){return this.runs.filter(r=>r.threadId===threadId).slice(0,8).reverse().map(r=>JSON.stringify({request:r.prompt,result:r.finalText||r.stages.filter(s=>s.status==='completed').map(s=>s.text.slice(-6000)).join('\n')})).join('\n').slice(-20000);}
  createRun(config,status){
    if(!config.prompt.trim())throw new Error('请输入需求');
    const id=uid();let parent=null;
    if(config.threadId){if(!validId(config.threadId))throw new Error('对话不存在');parent=this.runs.find(r=>r.threadId===config.threadId||r.id===config.threadId);if(!parent)throw new Error('对话不存在');}
    const threadId=parent?.threadId||parent?.id||id;
    const run={id,threadId,parentRunId:parent?.id??null,title:parent?.title||config.prompt.split('\n')[0].slice(0,60),prompt:config.prompt,workspace:this.workspace(config.workspace,id),pauseBetweenStages:!!config.pauseBetweenStages,createdAt:iso(),status,stages:[],events:[],finalText:'',context:parent?this.contextFor(threadId):'',requiresHumanAcceptance:true};
    this.runs.unshift(run);return run;
  }
  async proposeWorkflow(input){
    if(this.closed)throw new Error('应用正在退出');
    await this.refreshProviders(false);
    if(this.closed)throw new Error('应用正在退出');
    const config=validateConfig(input,{requireWorkspace:false});
    const starter=stageState({...config.starter,id:'starter',name:'启动模型',role:'plan',enabled:true});
    if(!this.ready(starter))throw new Error('启动模型尚未可用');
    const run=this.createRun({...config,threadId:input.threadId},'planning');
    run.starter=starter;
    this.config={...config,prompt:'',workspace:input.workspace||''};this.writePrivate('config.json',this.config);
    this.log(run,run.starter,'start','正在搭配流程');this.notify(run,true);queueMicrotask(()=>this.drain());return clone(run);
  }
  async generateProposal(id){
    const run=this.getRun(id);if(this.closed||run.status!=='planning'||this.pumps.has(id)||this.pumps.size>=this.maxConcurrent||this.workspaceBusy(run))return;this.pumps.add(id);
    try{
      const catalog=this.availableCatalog();
      const prompt=`根据本轮需求和实际可用智能体目录，选择合适的协作流程。只读查看工作目录，不修改文件，不创建产物，不执行工作流。先由人确认后才执行。只能从目录选择provider、model、effort；不要选择未列出或未认证的入口。最少3个最多8个环节，第一role=plan，最后role=review，中间至少一个execute，可按需求加design。首尾可用任意目录内智能体，优先少而有效。只输出JSON：{"title":"简短中文标题","stages":[{"id":"plan","name":"需求与方案","role":"plan","provider":"目录id","model":"目录模型id或空字符串","effort":"default"},...]}。id只用字母数字下划线横杠且唯一。不要Markdown围栏。\n<available_agents>${JSON.stringify(catalog)}</available_agents>\n工作目录：${run.workspace}\n<request>${run.prompt}</request>\n历史参考数据：${run.context}`;
      await this.executeStage(run,run.starter,prompt);
      if(run.status!=='planning')return;
      let proposal;try{proposal=JSON.parse(run.starter.text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw new Error('启动模型未返回有效流程，请重试');}
      const clean=validateConfig({prompt:run.prompt,workspace:run.workspace,stages:proposal.stages,starter:run.starter},{requireWorkspace:false});
      for(const stage of clean.stages.filter(s=>s.enabled)){
        const p=this.stageCapabilities(stage);const allowed=catalog.find(p=>p.id===stage.provider);
        if(!allowed||!this.ready(stage)||(stage.model&&!allowed.models.some(m=>m.id===stage.model)))throw new Error('推荐流程包含当前不可用的模型');
      }
      run.stages=clean.stages.map(stageState);run.proposal={title:redact(String(proposal.title||run.title)).slice(0,80)};
      if(!run.parentRunId)run.title=run.proposal.title;
      run.status='awaiting_confirmation';this.log(run,null,'proposal','流程待确认');
    }catch(error){if(!['cancelled','interrupted'].includes(run.status)){run.status='failed';run.error=redact(error.message);this.log(run,run.starter,'error',run.error);}}
    finally{this.pumps.delete(id);this.notify(run,true);this.drain();}
  }
  async confirmWorkflow({runId,stages,workspace}){
    const run=this.getRun(runId);if(run.status!=='awaiting_confirmation')throw new Error('当前没有待确认流程');
    const clean=validateConfig({prompt:run.prompt,workspace:workspace||run.workspace,stages,starter:run.starter},{requireWorkspace:false});
    for(const stage of clean.stages.filter(s=>s.enabled))if(!this.ready(stage))throw new Error('所选智能体或模型尚未就绪，请先登录并验证连接');
    if(workspace)run.workspace=this.workspace(workspace,run.id);
    this.checkWorkspace(run);run.stages=clean.stages.map(stageState);run.confirmedAt=iso();run.status='queued';run.error=null;
    this.log(run,null,'confirm','流程已确认');this.notify(run,true);queueMicrotask(()=>this.drain());return clone(run);
  }
  // Legacy/import entry points obey the same explicit human confirmation gate.
  async startRun(input){return this.proposeWorkflow(input);}
  workspaceBusy(run){return this.runs.some(r=>r.id!==run.id&&r.workspace===run.workspace&&(['running','waiting_handoff','cancelling'].includes(r.status)||r.status==='paused'&&(r.startedAt||r.stages.some(s=>s.status==='completed'))||r.status==='planning'&&this.pumps.has(r.id)));}
  drain(){
    if(this.closed)return;
    for(const run of [...this.runs].reverse()){
      if(this.pumps.size>=this.maxConcurrent)break;
      if(this.workspaceBusy(run)||this.pumps.has(run.id))continue;
      if(run.status==='planning')this.generateProposal(run.id);
      else if(run.status==='queued'){
        if(!run.confirmedAt){run.status='awaiting_confirmation';this.log(run,null,'confirm','流程待确认');this.notify(run,true);continue;}
        run.status='running';run.startedAt??=iso();this.notify(run,true);this.pump(run.id);
      }
    }
  }
  async executeStage(run,stage,prompt){
    const provider=this.stageCapabilities(stage);const controller=new AbortController();this.controllers.set(run.id,controller);
    stage.attempts??=[];stage.status='running';stage.text='';stage.error=null;stage.startedAt=iso();stage.finishedAt=null;
    delete stage.sessionId;delete stage.actualModelId;delete stage.origin;
    const attempt={id:uid(),providerId:stage.provider,modelId:stage.model,effort:stage.effort,startedAt:stage.startedAt,status:'running',usage:{...EMPTY_USAGE},text:''};stage.attempts.push(attempt);
    const record={runId:run.id,stageId:stage.id,attemptId:attempt.id,providerId:stage.provider,modelId:stage.model,
      effort:stage.effort,messageCapture:provider.messageCapture||'public-messages',input:redact(prompt),inputCaptured:true,output:'',messages:[],activities:[],truncated:false};
    let lastRecordWrite=0,recordingWarning=false;
    const saveRecord=()=>{if(!this.conversationStore)return;this.conversationStore.save({...record,...attempt,output:record.output});lastRecordWrite=Date.now();};
    const rememberMessage=event=>{
      if(event.messageCapture==='final-only')record.messageCapture='final-only';
      const text=redact(event.text??'');if(!text.trim())return;
      const key=String(event.id||'public-'+record.messages.length).slice(0,200);
      const existing=record.messages.find(m=>m.id===key);
      if(existing){const room=2097152-record.messages.filter(m=>m!==existing).reduce((n,m)=>n+Buffer.byteLength(m.text),0);existing.text=clipText(text,Math.max(0,Math.min(room,524288)));return;}
      const used=record.messages.reduce((n,m)=>n+Buffer.byteLength(m.text),0),room=2097152-used;
      if(record.messages.length>=256||room<=0){record.truncated=true;return;}
      record.messages.push({id:key,role:'assistant',text:clipText(text,Math.min(room,524288)),time:iso()});
      if(Buffer.byteLength(text)>Math.min(room,524288))record.truncated=true;
    };
    this.notify(run,true);
    try{
      saveRecord();
      const result=await this.runProvider({provider,stage:clone(stage),prompt,workspace:this.checkWorkspace(run),signal:controller.signal,onEvent:event=>{
        if(controller.signal.aborted||this.closed)return;
        if(event.type==='text'){
          const next=(event.replace?'':record.output)+redact(event.text??event.message??'');
          record.output=clipText(next,2097152);if(Buffer.byteLength(next)>2097152)record.truncated=true;
          stage.text=record.output.slice(-128000);
        }
        else if(event.type==='message')rememberMessage(event);
        else if(event.type==='usage'){attempt.usage=mergeUsage(attempt.usage,event.usage??event);stage.usage=aggregateUsage(stage.attempts.map(a=>a.usage));}
        else if(event.type==='session')attempt.sessionId=stage.sessionId=redact(event.sessionId??event.id??'').slice(0,200);
        else {
          const activity={time:iso(),type:String(event.activity||event.type||'activity').slice(0,100),message:redact(event.message??event.text??'执行中').slice(0,2000)};
          record.activities.push(activity);if(record.activities.length>200){record.activities.shift();record.truncated=true;}
          this.log(run,stage,event.type||'activity',activity.message);
        }
        if(Date.now()-lastRecordWrite>1500)try{saveRecord();}catch{if(!recordingWarning){recordingWarning=true;this.log(run,stage,'error','对话记录暂时无法保存，结束时将重试');}}
        this.notify(run);
      }});
      if(controller.signal.aborted)throw new Error('任务已取消');
      const finalOutput=redact(result.text??record.output);record.output=clipText(finalOutput,2097152);if(Buffer.byteLength(finalOutput)>2097152)record.truncated=true;
      stage.text=record.output.slice(-128000);if(result.usage)attempt.usage=mergeUsage(attempt.usage,result.usage);
      if(!stage.text.trim())throw new Error('智能体没有返回结果');
      attempt.status='completed';attempt.finishedAt=iso();attempt.text=stage.text;stage.usage=aggregateUsage(stage.attempts.map(a=>a.usage));stage.status='completed';stage.finishedAt=iso();
      if(result.sessionId)attempt.sessionId=stage.sessionId=redact(result.sessionId).slice(0,200);
      if(result.modelId)attempt.actualModelId=stage.actualModelId=redact(result.modelId).slice(0,240);
      if(result.origin)attempt.origin=stage.origin=redact(result.origin).slice(0,200);
      if(!record.messages.some(m=>m.text===record.output))rememberMessage({id:'final',text:record.output});
      saveRecord();return result;
    }catch(error){
      const status=this.closed?'interrupted':controller.signal.aborted?'cancelled':'failed';
      stage.status=status==='interrupted'?'failed':status;stage.error=redact(error.message||String(error));stage.finishedAt=iso();attempt.status=status;attempt.finishedAt=iso();attempt.text=stage.text;
      run.status=status;run.error=stage.error;this.log(run,stage,'error',stage.error);throw error;
    }finally{
      try{saveRecord();}catch{this.log(run,stage,'error','对话记录未能保存，请检查存储空间与文件权限');}
      this.controllers.delete(run.id);this.notify(run,true);
    }
  }
  async pump(id){
    if(this.pumps.has(id))return;const run=this.getRun(id);this.pumps.add(id);
    try{while(run.status==='running'&&!this.closed){
      const stage=run.stages.find(s=>s.status==='pending');if(!stage)throw new Error('未收到验收结论');
      const p=this.stageCapabilities(stage);
      if(!this.ready(stage)){
        stage.status='failed';stage.error=`${p.name} 尚未就绪，请先登录并验证连接`;run.status='failed';run.error=stage.error;
        this.log(run,stage,'error',stage.error);break;
      }
      this.log(run,stage,'start',`${p.name} · ${stage.name}`);
      await this.executeStage(run,stage,buildPrompt(run,stage));
      if(run.status!=='running')break;
      this.log(run,stage,'complete',`${stage.name}完成`);
      if(stage.role==='review'){this.applyVerdict(run,stage);break;}
      if(run.pauseRequested||run.pauseBetweenStages){run.status='paused';run.pauseRequested=false;break;}
    }}catch(error){if(!['cancelled','interrupted','failed'].includes(run.status)){run.status='failed';run.error=redact(error.message);this.log(run,null,'error',run.error);}}
    finally{this.pumps.delete(id);this.notify(run,true);this.drain();}
  }
  applyVerdict(run,stage){
    const verdict=parseVerdict(stage.text);run.verdict=verdict;run.finalText=verdict.summary;run.modelReviewedAt=iso();
    run.status=verdict.passed?'awaiting_acceptance':'review_failed';if(!verdict.passed)run.reviewFeedback=verdict;
    this.log(run,stage,'review',verdict.passed?'待你确认结果':'验收未通过');
  }
  confirmResult({runId,accepted,feedback=''}){
    const run=this.getRun(runId);if(run.status!=='awaiting_acceptance')throw new Error('当前没有待确认结果');
    if(typeof accepted!=='boolean'||typeof feedback!=='string'||feedback.length>16000)throw new Error('确认内容格式不正确');
    run.humanDecision={accepted,feedback:redact(feedback),time:iso()};
    if(accepted){run.status='completed';run.finishedAt=iso();this.log(run,null,'accept','已确认完成');}
    else{run.status='review_failed';run.reviewFeedback={summary:redact(feedback)||'用户要求继续修改',checks:run.verdict?.checks??[]};this.log(run,null,'reject','需要继续修改');}
    this.notify(run,true);this.drain();return clone(run);
  }
  controlRun({runId,action}){
    const run=this.getRun(runId);
    if(action==='cancel'){
      if(!ACTIVE.has(run.status)&&run.status!=='awaiting_confirmation')throw new Error('任务已结束');
      const ctrl=this.controllers.get(run.id);if(ctrl){run.status='cancelling';ctrl.abort();}else{run.status='cancelled';run.finishedAt=iso();for(const s of run.stages)if(s.status==='waiting_handoff')s.status='cancelled';}
    }else if(action==='pause'){
      if(run.status==='queued')run.status='paused';else if(run.status==='running')run.pauseRequested=true;else throw new Error('当前不能暂停');
    }else if(action==='resume'){
      if(run.status!=='paused')throw new Error('当前没有暂停');
      for(const s of run.stages.filter(s=>s.enabled&&s.status!=='completed'))if(!this.ready(s))throw new Error('请先登录或更换流程中未就绪的智能体');
      run.status='queued';queueMicrotask(()=>this.drain());
    }else if(action==='retry'){
      if(!['failed','review_failed','interrupted','cancelled'].includes(run.status))throw new Error('当前不能重试');
      if(run.starter&&run.stages.length===0){if(!this.ready(run.starter))throw new Error('请先登录并验证启动模型');run.status='planning';run.error=null;run.finishedAt=null;queueMicrotask(()=>this.drain());}
      else{
        let index=run.stages.findIndex(s=>['failed','cancelled','pending','running','waiting_handoff'].includes(s.status));
        if(run.status==='review_failed')index=run.stages.findLastIndex(s=>['design','execute'].includes(s.role)&&s.enabled);
        if(index<0)index=run.stages.length-1;
        for(const s of run.stages.slice(index).filter(s=>s.enabled))if(!this.ready(s))throw new Error('请先登录或更换流程中未就绪的智能体');
        for(let i=index;i<run.stages.length;i++){const s=run.stages[i];if(s.enabled){s.status='pending';s.error=null;s.text='';}}
        run.status='queued';run.error=null;run.finishedAt=null;run.pauseRequested=false;queueMicrotask(()=>this.drain());
      }
    }else throw new Error('不支持的操作');
    this.notify(run,true);if(run.status==='cancelled')this.drain();return clone(run);
  }
  updateStage({runId,stageId,...values}){
    const run=this.getRun(runId);const s=run.stages.find(s=>s.id===stageId);if(!s)throw new Error('环节不存在');
    if(!['pending','failed','cancelled','waiting_handoff'].includes(s.status)||['completed','cancelling','awaiting_acceptance'].includes(run.status))throw new Error('当前环节不可修改');
    const updated=validateStage({...s,provider:values.provider??s.provider,model:values.model??s.model,effort:values.effort??s.effort});if(!this.ready(updated))throw new Error('请先登录并验证所选智能体和模型');Object.assign(s,updated);
    if(s.status==='waiting_handoff'){s.status='pending';run.status='paused';delete s.prompt;}
    this.notify(run,true);return clone(run);
  }
  handoff({runId,stageId}){const run=this.getRun(runId);const s=run.stages.find(s=>s.id===stageId);if(run.status!=='waiting_handoff'||s?.status!=='waiting_handoff')throw new Error('当前没有等待交接');if(!this.ready(s))throw new Error('请先登录并验证该智能体');return {prompt:s.prompt||buildPrompt(run,s),provider:s.provider};}
  completeHandoff({runId,stageId,text}){
    const run=this.getRun(runId);const s=run.stages.find(s=>s.id===stageId);this.handoff({runId,stageId});
    if(typeof text!=='string'||!text.trim()||text.length>128000)throw new Error('请提交真实交接结果');
    s.text=redact(text);s.status='completed';s.startedAt=s.startedAt||iso();s.finishedAt=iso();s.handoff=true;s.usage={...EMPTY_USAGE,source:'交接用量未提供'};
    this.log(run,s,'handoff','已收到交接结果');
    if(s.role==='review')this.applyVerdict(run,s);else run.status=run.pauseBetweenStages?'paused':'queued';
    this.notify(run,true);queueMicrotask(()=>this.drain());return clone(run);
  }
  shutdown(){
    this.closed=true;clearTimeout(this.tick);for(const c of this.controllers.values())c.abort();
    for(const run of this.runs)if(RECOVER.has(run.status)||run.status==='cancelling'){
      run.status='interrupted';for(const s of [...run.stages,...(run.starter?[run.starter]:[])]){if(s.status==='running'){s.status='failed';s.error='任务已中断';}for(const a of s.attempts??[])if(a.status==='running'){a.status='interrupted';a.finishedAt=iso();}}
      this.persist(run);
    }
    for(const id of this.dirty){const r=this.runs.find(r=>r.id===id);if(r)this.persist(r);}this.dirty.clear();
  }
}
module.exports={...domain,Engine};

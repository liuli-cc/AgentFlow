'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Engine,createDefaultConfig,EMPTY_USAGE}=require('../lib/engine.cjs');

const verdict=JSON.stringify({passed:true,summary:'实际产物符合需求',checks:[{name:'文件检查',passed:true,evidence:'已核对任务目录中的实际产物'}]});
const usage={input:5,output:2,cacheRead:0,cacheWrite:0,reasoning:0,costUSD:null,source:'test fixture'};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const providers=()=>[
  {id:'codex',name:'Codex',ready:true,installed:true,mode:'cli',models:[{id:'m',ready:true,efforts:['low','high']}],efforts:['default','low','high']},
  {id:'dsh',name:'DSH',ready:false,installed:true,mode:'cli',models:[{id:'m',ready:false,efforts:['low','high']}],efforts:['default','low','high']},
  {id:'api-unverified',name:'Unverified API',ready:false,installed:true,mode:'api',models:[{id:'m',ready:false,efforts:['low','high']}],efforts:['default','low','high']},
];
const stages=()=>['plan','execute','review'].map(role=>({id:role,name:role,role,provider:'codex',model:'m',effort:'low',enabled:true}));
async function waitFor(predicate,label='expected state',milliseconds=3000){const deadline=Date.now()+milliseconds;while(Date.now()<deadline){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Timed out: '+label);}

async function fixture(t,implementation){
  const base=path.resolve(__dirname,'../../../work/thread-actions-tests');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'case-'));const workspace=path.join(root,'project');fs.mkdirSync(workspace);
  const dataDir=path.join(root,'state');const trash=path.join(root,'injected-trash');fs.mkdirSync(trash);const calls=[];const discovered=providers();
  const engine=new Engine({dataDir,detectProviders:()=>discovered,runProvider:async args=>{
    calls.push({id:args.stage.id,role:args.stage.role,provider:args.provider.id});
    return implementation?implementation(args):{text:args.stage.id==='starter'?JSON.stringify({title:'测试对话',stages:stages()}):args.stage.role==='review'?verdict:'真实结果',usage};
  }});await engine.init();
  t.after(()=>{engine.shutdown();fs.rmSync(root,{recursive:true,force:true});});
  const config={...createDefaultConfig(),workspace,prompt:'创建可验收的产物',stages:stages(),starter:{provider:'codex',model:'m',effort:'low'}};
  const current=id=>engine.getState().runs.find(run=>run.id===id);
  const trashed=[];
  const trashItem=async file=>{trashed.push(file);fs.renameSync(file,path.join(trash,path.basename(file)));};
  return {root,workspace,dataDir,trash,engine,discovered,calls,config,current,trashed,trashItem};
}
function seed(f,{threadId,status='completed',workspace,prompt='历史任务'}={}){
  const run=f.engine.createRun({...f.config,prompt,workspace:workspace===undefined?f.workspace:workspace,...(threadId?{threadId}:{})},status);
  run.stages=stages().map(stage=>({...stage,status:status==='completed'?'completed':'pending',text:status==='completed'?'已完成':'',error:null,usage:{...EMPTY_USAGE},attempts:[]}));
  if(status==='completed'){run.finalText='已确认结果';run.finishedAt=new Date().toISOString();}
  f.engine.persist(run);return run;
}
async function proposed(f){const run=await f.engine.proposeWorkflow(f.config);await waitFor(()=>f.current(run.id)?.status==='awaiting_confirmation','proposal');return run;}

test('删除整段多轮对话只将其记录交给回收站，保留产物与其他对话',async t=>{
  const f=await fixture(t);const first=seed(f);const second=seed(f,{threadId:first.threadId});const third=seed(f,{threadId:first.threadId,status:'review_failed'});
  const otherWorkspace=path.join(f.root,'other-project');fs.mkdirSync(otherWorkspace);const other=seed(f,{workspace:otherWorkspace});
  const artifact=path.join(f.workspace,'deliverable.txt');fs.writeFileSync(artifact,'keep my work');
  f.engine.saveConfig({...f.config,workspace:f.workspace});
  const state=await f.engine.deleteThread({threadId:first.threadId},f.trashItem);
  assert.deepEqual(state.runs.map(run=>run.id),[other.id]);
  assert.deepEqual(new Set(f.trashed),new Set([first,second,third].map(run=>path.join(f.dataDir,'runs',run.id+'.json'))));
  for(const run of [first,second,third]){assert.equal(fs.existsSync(path.join(f.dataDir,'runs',run.id+'.json')),false);assert.equal(fs.existsSync(path.join(f.trash,run.id+'.json')),true);}
  assert.equal(fs.readFileSync(artifact,'utf8'),'keep my work');assert.equal(fs.existsSync(path.join(f.dataDir,'runs',other.id+'.json')),true);
  assert.equal(state.config.workspace,'');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir,'config.json'),'utf8')).workspace,'');
});

test('删除托管对话保留自动创建的目录与文件，共用目录的其他对话使默认目录继续保留',async t=>{
  const f=await fixture(t);const managed=seed(f,{workspace:''});const artifact=path.join(managed.workspace,'output.txt');fs.writeFileSync(artifact,'managed output');
  await f.engine.deleteThread({threadId:managed.threadId},f.trashItem);assert.equal(fs.readFileSync(artifact,'utf8'),'managed output');
  const one=seed(f);const two=seed(f);f.engine.saveConfig(f.config);await f.engine.deleteThread({threadId:one.threadId},f.trashItem);
  assert(f.current(two.id));assert.equal(f.engine.getState().config.workspace,f.workspace);
});

test('规划、运行、排队、取消中的任一轮阻止整段删除，活动 controller 或 pump 也阻止',async t=>{
  for(const status of ['planning','running','queued','cancelling']){
    const f=await fixture(t);const first=seed(f);const active=seed(f,{threadId:first.threadId,status});
    await assert.rejects(f.engine.deleteThread({threadId:first.threadId},f.trashItem),/先取消/);
    assert(f.current(first.id));assert(f.current(active.id));assert.equal(f.trashed.length,0);
  }
  for(const kind of ['controller','pump']){
    const f=await fixture(t);const run=seed(f,{status:'paused'});
    if(kind==='controller')f.engine.controllers.set(run.id,new AbortController());else f.engine.pumps.add(run.id);
    await assert.rejects(f.engine.deleteThread({threadId:run.threadId},f.trashItem),/先取消/);
    assert.equal(f.trashed.length,0);f.engine.controllers.clear();f.engine.pumps.clear();
  }
});

test('已暂停且没有活动执行器的对话允许删除',async t=>{
  const f=await fixture(t);const run=seed(f,{status:'paused'});await f.engine.deleteThread({threadId:run.threadId},f.trashItem);
  assert.equal(f.current(run.id),undefined);assert.equal(f.trashed.length,1);
});

test('回收站操作等待期间不能恢复、确认或重复删除同一对话',async t=>{
  const f=await fixture(t);const first=seed(f,{status:'paused'});const confirmation=seed(f,{threadId:first.threadId,status:'awaiting_confirmation'});const acceptance=seed(f,{threadId:first.threadId,status:'awaiting_acceptance'});
  const gate=deferred();let entered=false;
  const pending=f.engine.deleteThread({threadId:first.threadId},async file=>{entered=true;await gate.promise;await f.trashItem(file);});
  await waitFor(()=>entered,'trash entered');assert.equal(f.engine.getState().runs.length,0);
  assert.throws(()=>f.engine.controlRun({runId:first.id,action:'resume'}),/任务不存在/);
  await assert.rejects(f.engine.confirmWorkflow({runId:confirmation.id,stages:stages()}),/任务不存在/);
  assert.throws(()=>f.engine.confirmResult({runId:acceptance.id,accepted:true}),/任务不存在/);
  await assert.rejects(f.engine.deleteThread({threadId:first.threadId},f.trashItem),/对话不存在/);
  gate.resolve();await pending;assert.equal(f.calls.length,0);
});

test('部分回收站操作失败会恢复全部记录，同时保留等待期间新建的并发对话',async t=>{
  const f=await fixture(t);const first=seed(f);const second=seed(f,{threadId:first.threadId,status:'paused'});const originalOther=seed(f);
  const gate=deferred();let attempted=0;
  const pending=f.engine.deleteThread({threadId:first.threadId},async file=>{attempted++;if(attempted===1){await f.trashItem(file);return;}await gate.promise;throw new Error('synthetic trash failure');});
  await waitFor(()=>attempted===2,'second trash');
  const concurrent=seed(f,{prompt:'删除等待时创建的新对话'});f.engine.saveConfig({...f.config,prompt:'新的默认草稿'});
  gate.resolve();await assert.rejects(pending,/已保留对话记录/);
  for(const run of [first,second,originalOther,concurrent]){assert(f.current(run.id));assert.equal(fs.existsSync(path.join(f.dataDir,'runs',run.id+'.json')),true);}
  assert.equal(f.engine.getState().runs.length,4);assert.equal(f.engine.getState().config.prompt,'新的默认草稿');
  assert.equal(fs.existsSync(f.workspace),true);
});

test('成功删除后刷新与重启不会使历史记录复活，未删除的记录与工作目录继续存在',async t=>{
  const f=await fixture(t);const first=seed(f);const second=seed(f,{threadId:first.threadId});const kept=seed(f);
  await f.engine.deleteThread({threadId:first.threadId},f.trashItem);f.engine.flush();
  const restored=new Engine({dataDir:f.dataDir,detectProviders:providers,runProvider:async()=>{throw new Error('reboot must not call an agent');}});await restored.init();t.after(()=>restored.shutdown());
  const ids=restored.getState().runs.map(run=>run.id);assert(!ids.includes(first.id));assert(!ids.includes(second.id));assert(ids.includes(kept.id));assert.equal(fs.existsSync(f.workspace),true);
});

test('非法、未知或非对话标识不会进入回收站，也不能通过路径值删除文件',async t=>{
  const f=await fixture(t);const run=seed(f);
  for(const threadId of ['',null,12,{},'../runs','../../workspace','not-a-uuid','01234567-89ab-4cde-8fab-0123456789ab']){
    await assert.rejects(f.engine.deleteThread({threadId},f.trashItem),/对话不存在/);
  }
  await assert.rejects(f.engine.deleteThread({threadId:run.threadId},null),/对话不存在/);
  assert.equal(f.trashed.length,0);assert(f.current(run.id));
});

test('确认流程硬拒绝未登录智能体和未验证 API，不执行、不改写已推荐团队',async t=>{
  for(const provider of ['dsh','api-unverified']){
    const f=await fixture(t);const run=await proposed(f);const original=JSON.stringify(f.current(run.id).stages);const changed=stages();changed[1].provider=provider;
    await assert.rejects(f.engine.confirmWorkflow({runId:run.id,stages:changed}),/尚未就绪|先登录/);
    assert.equal(f.current(run.id).status,'awaiting_confirmation');assert.equal(f.current(run.id).confirmedAt,undefined);assert.equal(JSON.stringify(f.current(run.id).stages),original);assert.deepEqual(f.calls.map(call=>call.id),['starter']);
  }
});

test('updateStage 硬拒绝未就绪智能体以及同一提供方内未验证的模型',async t=>{
  const f=await fixture(t);const run=await proposed(f);f.discovered[0].models.push({id:'unverified-model',ready:false,efforts:['low']});
  for(const change of [{provider:'dsh'},{provider:'api-unverified'},{model:'unverified-model'}]){
    assert.throws(()=>f.engine.updateStage({runId:run.id,stageId:'execute',...change}),/先登录|验证/);
    assert.equal(f.current(run.id).stages[1].provider,'codex');assert.equal(f.current(run.id).stages[1].model,'m');
  }
  assert.deepEqual(f.calls.map(call=>call.id),['starter']);
});

test('暂停后认证失效会拒绝继续，不能通过 handoff 回执跳过',async t=>{
  const f=await fixture(t);const run=await proposed(f);
  f.engine.getRun(run.id).pauseBetweenStages=true;
  await f.engine.confirmWorkflow({runId:run.id,stages:stages()});await waitFor(()=>f.current(run.id)?.status==='paused','paused after plan');
  f.discovered[0].ready=false;f.discovered[0].models[0].ready=false;await f.engine.refreshProviders();
  assert.throws(()=>f.engine.controlRun({runId:run.id,action:'resume'}),/先登录|未就绪/);
  assert.deepEqual(f.calls.map(call=>call.id),['starter','plan']);assert.equal(f.current(run.id).stages[1].status,'pending');assert.equal(f.current(run.id).stages[1].handoff,undefined);
  assert.throws(()=>f.engine.handoff({runId:run.id,stageId:'execute'}));
  assert.throws(()=>f.engine.completeHandoff({runId:run.id,stageId:'execute',text:'pretend completed'}));
  assert.equal(f.current(run.id).status,'paused');assert.equal(f.current(run.id).verdict,undefined);
});

test('环节之间失去认证会立即失败，不调用后续未就绪模型',async t=>{
  const f=await fixture(t,async({stage})=>{
    if(stage.id==='starter')return {text:JSON.stringify({stages:stages()}),usage};
    if(stage.role==='plan')f.discovered[0].ready=false;
    return {text:'规划结果',usage};
  });
  const run=await proposed(f);await f.engine.confirmWorkflow({runId:run.id,stages:stages()});
  await waitFor(()=>f.current(run.id)?.status==='failed','lost auth between stages');
  assert.deepEqual(f.calls.map(call=>call.id),['starter','plan']);
  assert.match(f.current(run.id).error,/先登录|未就绪/);
  assert.equal(f.current(run.id).stages[1].status,'failed');
  assert.throws(()=>f.engine.completeHandoff({runId:run.id,stageId:'execute',text:'skip'}));
});

test('实际调用返回鉴权错误保留失败尝试和已用计量，不调用验收或人工交接',async t=>{
  const f=await fixture(t,async({stage,onEvent})=>{
    if(stage.id==='starter')return {text:JSON.stringify({stages:stages()}),usage};
    if(stage.role==='execute'){onEvent({type:'usage',usage});throw new Error('API 返回 HTTP 401。');}
    return {text:stage.role==='review'?verdict:'规划结果',usage};
  });
  const run=await proposed(f);await f.engine.confirmWorkflow({runId:run.id,stages:stages()});await waitFor(()=>f.current(run.id)?.status==='failed','HTTP auth failure');
  assert.deepEqual(f.calls.map(call=>call.id),['starter','plan','execute']);assert.match(f.current(run.id).error,/401/);assert.equal(f.current(run.id).stages[1].attempts[0].status,'failed');assert.equal(f.current(run.id).stages[1].usage.input,5);
  assert.throws(()=>f.engine.completeHandoff({runId:run.id,stageId:'execute',text:'skip authentication'}));assert.equal(f.current(run.id).status,'failed');
});

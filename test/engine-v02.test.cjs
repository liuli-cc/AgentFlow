'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Engine,createDefaultConfig,validateConfig,validateWorkspace,normalizedUsage}=require('../lib/engine.cjs');
const verdict=JSON.stringify({passed:true,summary:'文件与需求一致',checks:[{name:'交付文件',passed:true,evidence:'已核对实际文件'}]});
const usage={input:5,output:2,cacheRead:1,cacheWrite:0,reasoning:1,costUSD:null,source:'fixture'};
const providers=()=>['codex','claude','dsh','api-test'].map(id=>({id,name:id,mode:id==='api-test'?'api':'cli',ready:true,models:[{id:'m',label:'m',ready:true,efforts:['low','high']}],efforts:['default','low','high']}));
const stages=()=>[
  {id:'plan',name:'方案',role:'plan',provider:'claude',model:'m',effort:'low'},
  {id:'execute',name:'执行',role:'execute',provider:'dsh',model:'m',effort:'low'},
  {id:'review',name:'验收',role:'review',provider:'api-test',model:'m',effort:'high'},
];
const proposal=()=>JSON.stringify({title:'推荐团队',stages:stages()});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function waitFor(predicate,label='状态',ms=3000){const end=Date.now()+ms;while(Date.now()<end){const result=predicate();if(result)return result;await new Promise(done=>setTimeout(done,5));}throw new Error('等待超时: '+label);}
async function fixture(t,implementation,options={}){
  const base=path.resolve(__dirname,'../../../work/engine-v02-tests');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'case-'));const workspace=path.join(root,'project');fs.mkdirSync(workspace);
  const calls=[];
  const engine=new Engine({dataDir:path.join(root,'data'),detectProviders:providers,runProvider:async args=>{calls.push({id:args.stage.id,role:args.stage.role,provider:args.provider.id,workspace:args.workspace,signal:args.signal});return implementation?implementation(args):{text:args.stage.id==='starter'?proposal():args.stage.role==='review'?verdict:'实现结果',usage};},...options});
  await engine.init();
  t.after(()=>{engine.shutdown();fs.rmSync(root,{force:true,recursive:true});});
  const config={...createDefaultConfig(),prompt:'创建工作成果',workspace,stages:stages(),starter:{provider:'codex',model:'m',effort:'low'}};
  const current=id=>engine.getState().runs.find(run=>run.id===id);
  return {root,workspace,engine,calls,config,current};
}

test('启动模型的真实推荐只读运行，确认前没有任何执行或设计调用',async t=>{
  const f=await fixture(t);const run=await f.engine.proposeWorkflow(f.config);
  await waitFor(()=>f.current(run.id).status==='awaiting_confirmation');
  assert.deepEqual(f.calls.map(call=>call.id),['starter']);
  assert.equal(f.calls[0].role,'plan');
  assert.equal(f.current(run.id).confirmedAt,undefined);
  assert.equal(f.current(run.id).starter.usage.input,5);
  assert.equal(f.current(run.id).stages[0].provider,'claude');
  await new Promise(done=>setTimeout(done,20));assert.equal(f.calls.length,1);
  await f.engine.confirmWorkflow({runId:run.id,stages:stages()});
  await waitFor(()=>f.current(run.id).status==='awaiting_acceptance');
  assert.deepEqual(f.calls.map(call=>call.provider),['codex','claude','dsh','api-test']);
  assert.equal(f.current(run.id).humanDecision,undefined);
  await new Promise(done=>setTimeout(done,10));assert.equal(f.current(run.id).status,'awaiting_acceptance');
  f.engine.confirmResult({runId:run.id,accepted:true});
  assert.equal(f.current(run.id).status,'completed');
  assert.equal(f.current(run.id).humanDecision.accepted,true);
});

test('旧 startRun 入口也必须先推荐并等待确认',async t=>{
  const f=await fixture(t);const run=await f.engine.startRun(f.config);
  await waitFor(()=>f.current(run.id).status==='awaiting_confirmation');
  assert.deepEqual(f.calls.map(call=>call.id),['starter']);
  assert.throws(()=>f.engine.confirmResult({runId:run.id,accepted:true}),/没有待确认结果/);
});

test('启动配置不能覆盖只读角色或启动标识',async t=>{
  const f=await fixture(t);
  f.config.starter={...f.config.starter,id:'execute',role:'execute',name:'伪造启动',enabled:false};
  const clean=validateConfig(f.config,{requireWorkspace:false});assert.deepEqual(clean.starter,{provider:'codex',model:'m',effort:'low'});
  const run=await f.engine.proposeWorkflow(f.config);await waitFor(()=>f.current(run.id).status==='awaiting_confirmation');
  assert.equal(f.calls[0].id,'starter');assert.equal(f.calls[0].role,'plan');
});

test('未认证、未列出或不可用的推荐模型不能进入确认后的执行',async t=>{
  for(const variant of ['missing-provider','missing-model','unavailable']){
    const catalog=providers();if(variant==='unavailable')catalog.find(provider=>provider.id==='claude').models[0].ready=false;
    const f=await fixture(t,async()=>{const list=stages();if(variant==='missing-provider')list[0].provider='unseen';if(variant==='missing-model')list[0].model='unknown';return {text:JSON.stringify({stages:list}),usage};},{detectProviders:()=>catalog});
    const run=await f.engine.proposeWorkflow(f.config);await waitFor(()=>f.current(run.id).status==='failed');
    assert.equal(f.calls.length,1);assert.equal(f.current(run.id).stages.length,0);
  }
});

test('并发提交即使共用异步发现也严格遵守模型调用上限',async t=>{
  let active=0,max=0;const gates=[];
  const f=await fixture(t,async({signal})=>{active++;max=Math.max(max,active);const gate=deferred();gates.push(gate);await Promise.race([gate.promise,new Promise(done=>signal.addEventListener('abort',done,{once:true}))]);active--;return {text:proposal(),usage};},{maxConcurrent:1,detectProviders:async()=>{await new Promise(done=>setTimeout(done,5));return providers();}});
  const configs=[0,1,2].map(index=>{const dir=path.join(f.root,'project-'+index);fs.mkdirSync(dir);return {...f.config,workspace:dir};});
  const runs=await Promise.all(configs.map(config=>f.engine.proposeWorkflow(config)));
  await waitFor(()=>gates.length===1);assert.equal(max,1);assert.equal(f.calls.length,1);
  gates[0].resolve();await waitFor(()=>gates.length===2);gates[1].resolve();await waitFor(()=>gates.length===3);gates[2].resolve();
  await waitFor(()=>runs.every(run=>f.current(run.id).status==='awaiting_confirmation'));assert.equal(max,1);
});

test('不同目录可以并行，同一目录的启动推荐和执行均串行',async t=>{
  const gates=new Map();const activeByWorkspace=new Map();let maxSame=0;let simultaneous=0,maxAll=0;
  const f=await fixture(t,async args=>{
    const n=(activeByWorkspace.get(args.workspace)||0)+1;activeByWorkspace.set(args.workspace,n);maxSame=Math.max(maxSame,n);maxAll=Math.max(maxAll,++simultaneous);
    const gate=deferred();gates.set(args.workspace,gate);await Promise.race([gate.promise,new Promise(done=>args.signal.addEventListener('abort',done,{once:true}))]);
    activeByWorkspace.set(args.workspace,n-1);simultaneous--;
    return {text:args.stage.id==='starter'?proposal():args.stage.role==='review'?verdict:'结果',usage};
  },{maxConcurrent:2});
  const other=path.join(f.root,'other');fs.mkdirSync(other);
  const a=await f.engine.proposeWorkflow(f.config);const b=await f.engine.proposeWorkflow({...f.config,prompt:'同目录后续'});const c=await f.engine.proposeWorkflow({...f.config,workspace:other});
  await waitFor(()=>f.calls.length===2);assert.equal(maxAll,2);assert.equal(maxSame,1);
  gates.get(f.workspace).resolve();gates.get(other).resolve();await waitFor(()=>f.calls.length===3);
  gates.get(f.workspace).resolve();await waitFor(()=>[a,b,c].every(run=>f.current(run.id).status==='awaiting_confirmation'));
  await f.engine.confirmWorkflow({runId:a.id,stages:stages()});await f.engine.confirmWorkflow({runId:b.id,stages:stages()});
  await waitFor(()=>f.calls.length===4);assert.equal(f.current(b.id).status,'queued');
  f.engine.controlRun({runId:a.id,action:'cancel'});await waitFor(()=>f.current(a.id).status==='cancelled');
  await waitFor(()=>f.calls.length===5);assert.equal(maxSame,1);
  f.engine.controlRun({runId:b.id,action:'cancel'});await waitFor(()=>f.current(b.id).status==='cancelled');
});

test('取消并重试启动推荐保留尝试及用量，仍然需要人工确认',async t=>{
  let starts=0;
  const f=await fixture(t,async({signal,onEvent})=>{if(++starts===1){onEvent({type:'usage',usage});await new Promise((done,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}return {text:proposal(),usage};});
  const run=await f.engine.proposeWorkflow(f.config);await waitFor(()=>f.calls.length===1);
  f.engine.controlRun({runId:run.id,action:'cancel'});await waitFor(()=>f.current(run.id).status==='cancelled');
  f.engine.controlRun({runId:run.id,action:'retry'});await waitFor(()=>f.current(run.id).status==='awaiting_confirmation');
  assert.equal(f.current(run.id).starter.attempts.length,2);assert.equal(f.current(run.id).starter.usage.input,10);assert.equal(f.calls.length,2);
});

test('人工否决后只重跑执行与验收，保留规划并再次等待人工验收',async t=>{
  const f=await fixture(t);const run=await f.engine.proposeWorkflow(f.config);await waitFor(()=>f.current(run.id).status==='awaiting_confirmation');
  await f.engine.confirmWorkflow({runId:run.id,stages:stages()});await waitFor(()=>f.current(run.id).status==='awaiting_acceptance');
  f.engine.confirmResult({runId:run.id,accepted:false,feedback:'还缺一个文件'});assert.equal(f.current(run.id).status,'review_failed');
  f.engine.controlRun({runId:run.id,action:'retry'});await waitFor(()=>f.current(run.id).status==='awaiting_acceptance');
  assert.deepEqual(f.calls.map(call=>call.id),['starter','plan','execute','review','execute','review']);
  assert.equal(f.current(run.id).stages[1].usage.input,10);
});

test('托管任务目录可自动创建，拒绝托管根目录或任务目录被符号链接替换',async t=>{
  const f=await fixture(t);const run=await f.engine.proposeWorkflow({...f.config,workspace:''});await waitFor(()=>f.current(run.id).status==='awaiting_confirmation');
  assert.equal(path.dirname(run.workspace),f.engine.managedRoot);assert.equal(path.basename(run.workspace),run.id);
  const fakeHome=path.join(f.root,'home');const root=path.join(fakeHome,'Library','AppSupport','workspaces');fs.mkdirSync(root,{recursive:true});
  const id='01234567-89ab-4cde-8fab-0123456789ab';const target=path.join(root,id);fs.mkdirSync(target);
  assert.equal(validateWorkspace(target,{home:fakeHome,managedRoot:root}),target);
  const alias=path.join(root,'01234567-89ab-4cde-8fab-0123456789ac');fs.symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');assert.throws(()=>validateWorkspace(alias,{home:fakeHome,managedRoot:root}),/符号链接/);
  const renamed=root+'-original';fs.renameSync(root,renamed);fs.symlinkSync(renamed,root,process.platform==='win32'?'junction':'dir');assert.throws(()=>validateWorkspace(path.join(root,id),{home:fakeHome,managedRoot:root}),/被替换/);
});

test('过往任务继续采用同一对话历史，不会覆盖原任务或原有模型选择',async t=>{
  const f=await fixture(t);const first=await f.engine.proposeWorkflow(f.config);await waitFor(()=>f.current(first.id).status==='awaiting_confirmation');
  await f.engine.confirmWorkflow({runId:first.id,stages:stages()});await waitFor(()=>f.current(first.id).status==='awaiting_acceptance');f.engine.confirmResult({runId:first.id,accepted:true});
  const second=await f.engine.proposeWorkflow({...f.config,prompt:'继续增加功能',threadId:first.threadId,starter:{provider:'claude',model:'m',effort:'high'}});
  await waitFor(()=>f.current(second.id).status==='awaiting_confirmation');
  assert.equal(second.threadId,first.threadId);assert.equal(second.parentRunId,first.id);assert.match(second.context,/创建工作成果/);assert.equal(f.current(first.id).status,'completed');
  assert.equal(f.current(second.id).starter.provider,'claude');assert.equal(f.current(second.id).starter.effort,'high');
});

test('缓存读写不能超过总输入，reasoning 不能超过总输出',()=>{
  const result=normalizedUsage({input:10,output:4,cacheRead:8,cacheWrite:8,reasoning:5});
  assert.equal(result.cacheRead,8);assert.equal(result.cacheWrite,null);assert.equal(result.reasoning,null);
});

test('最后响应只给部分计量时保留此前流式收到的实际字段',async t=>{
  const f=await fixture(t,async({stage,onEvent})=>{
    onEvent({type:'usage',usage});
    return {text:stage.id==='starter'?proposal():stage.role==='review'?verdict:'结果',usage:{input:6}};
  });
  const run=await f.engine.proposeWorkflow(f.config);await waitFor(()=>f.current(run.id).status==='awaiting_confirmation');
  assert.equal(f.current(run.id).starter.usage.input,6);assert.equal(f.current(run.id).starter.usage.output,2);assert.equal(f.current(run.id).starter.usage.cacheRead,1);
});

test('重启中的启动推荐变为中断，不自动恢复模型调用',async t=>{
  const f=await fixture(t,async({signal,onEvent})=>{onEvent({type:'usage',usage});await new Promise((done,reject)=>signal.addEventListener('abort',()=>reject(new Error('closed')),{once:true}));return {text:proposal(),usage};});
  const run=await f.engine.proposeWorkflow(f.config);await waitFor(()=>f.calls.length===1);f.engine.shutdown();
  let externalCalls=0;const restored=new Engine({dataDir:f.engine.dataDir,detectProviders:providers,runProvider:async()=>{externalCalls++;return {text:proposal()};}});
  await restored.init();t.after(()=>restored.shutdown());
  const saved=restored.getState().runs.find(item=>item.id===run.id);assert.equal(saved.status,'interrupted');assert.equal(saved.starter.status,'failed');assert.equal(saved.starter.attempts[0].status,'interrupted');assert.equal(saved.starter.usage.input,5);assert.equal(externalCalls,0);
  // The original process finishes its cancellation bookkeeping before fixture cleanup.
  await waitFor(()=>f.engine.pumps.size===0);
});

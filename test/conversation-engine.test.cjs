'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {Engine,createDefaultConfig}=require('../lib/engine.cjs');
const {ConversationStore}=require('../lib/conversations.cjs');
async function setup(t,implementation){
 const parent=path.resolve(__dirname,'../../../work/conversation-engine-tests');fs.mkdirSync(parent,{recursive:true});
 const root=fs.mkdtempSync(path.join(parent,'case-')),workspace=path.join(root,'project');fs.mkdirSync(workspace);
 const provider={id:'codex',name:'Codex',mode:'cli',ready:true,models:[{id:'selected',efforts:['low']}],efforts:['low']};
 const engine=new Engine({dataDir:path.join(root,'data'),detectProviders:()=>[provider],runProvider:implementation});await engine.init();
 const validate=ids=>{const r=engine.runs.find(r=>r.id===ids.runId);if(!r)return false;if(!ids.stageId)return true;const s=r.stages.find(s=>s.id===ids.stageId);return !!s?.attempts.find(a=>a.id===ids.attemptId);};
 const store=new ConversationStore({dataDir:engine.dataDir,validate});engine.conversationStore=store;
 const run=engine.createRun({...createDefaultConfig(),workspace,prompt:'User question'},'running');
 const stage={id:'execute',name:'Execute',role:'execute',provider:'codex',model:'selected',effort:'low',attempts:[]};run.stages=[stage];
 t.after(()=>{engine.shutdown();fs.rmSync(root,{recursive:true,force:true});});return {root,workspace,engine,store,run,stage};
}
test('records preserve actual sent input, all public messages, full final reply, usage and session across reload',async t=>{
 const output='完整回复'.repeat(50000);const f=await setup(t,async({prompt,onEvent})=>{
  assert.match(prompt,/Actual orchestration input/);onEvent({type:'session',sessionId:'session-1'});
  onEvent({type:'message',id:'public-1',role:'assistant',text:'先检查文件'});onEvent({type:'message',id:'public-1',role:'assistant',text:'先检查文件'});
  onEvent({type:'activity',activity:'tool_call',text:'Read'});onEvent({type:'text',replace:true,text:output});
  return {text:output,modelId:'actual-model',sessionId:'session-1',usage:{input:100,output:20,cacheRead:null}};
 });
 const input='Actual orchestration input\n<request>User question</request>\napi_key=sk-123456789012345678901234';
 await f.engine.executeStage(f.run,f.stage,input);const attempt=f.stage.attempts[0];
 const ids={runId:f.run.id,stageId:f.stage.id,attemptId:attempt.id};const record=f.store.get(ids);
 assert.match(record.input,/Actual orchestration input/);assert(!record.input.includes('sk-123456789'));assert.equal(record.inputCaptured,true);
 assert.equal(record.output,output);assert(f.stage.text.length<output.length);assert.equal(record.messages.length,2);assert.equal(record.messages[0].text,'先检查文件');
 assert.equal(record.actualModelId,'actual-model');assert.equal(record.sessionId,'session-1');assert.equal(record.usage.cacheRead,null);assert.equal(record.activities[0].message,'Read');
 const state=f.engine.getState();assert(!JSON.stringify(state).includes('Actual orchestration input'));assert.equal(state.telemetry.recentCalls[0].modelId,'actual-model');
 const reloaded=new ConversationStore({dataDir:f.engine.dataDir,validate:()=>true});assert.equal(reloaded.get(ids).output,output);
});
test('failed retry keeps its own session/model and partial output, without leaking a former session into the retry',async t=>{
 let call=0;const f=await setup(t,async({stage,onEvent})=>{call++;assert.equal(stage.sessionId,undefined);
  if(call===1){onEvent({type:'session',sessionId:'old-session'});onEvent({type:'text',text:'partial',replace:true});throw new Error('network failed');}
  return {text:'retry success',modelId:'new-model',usage:{input:3,output:2}};
 });
 await assert.rejects(f.engine.executeStage(f.run,f.stage,'first'),/network failed/);f.run.status='running';
 await f.engine.executeStage(f.run,f.stage,'retry');const [one,two]=f.stage.attempts;
 const ids={runId:f.run.id,stageId:f.stage.id};assert.equal(f.store.get({...ids,attemptId:one.id}).output,'partial');
 assert.equal(f.store.get({...ids,attemptId:one.id}).status,'failed');assert.equal(f.store.get({...ids,attemptId:one.id}).sessionId,'old-session');
 assert.equal(f.store.get({...ids,attemptId:two.id}).sessionId,null);assert.equal(two.actualModelId,'new-model');
});
test('deleting a conversation trashes its transcript too; a failed trash restores both without touching the workspace',async t=>{
 const f=await setup(t,async()=>({text:'reply',modelId:'actual-model'}));await f.engine.executeStage(f.run,f.stage,'input');f.run.status='completed';
 const artifact=path.join(f.workspace,'deliverable.txt');fs.writeFileSync(artifact,'keep');const recordPath=f.store.runPath(f.run.id);
 const trash=path.join(f.root,'trash');fs.mkdirSync(trash);let moved;
 await assert.rejects(f.engine.deleteThread({threadId:f.run.threadId},async file=>{if(file===recordPath)throw new Error('synthetic failure');moved=path.join(trash,path.basename(file));fs.renameSync(file,moved);}),/已保留/);
 assert(f.engine.getRun(f.run.id));assert(fs.existsSync(recordPath));assert.equal(fs.readFileSync(artifact,'utf8'),'keep');fs.unlinkSync(moved);
 await f.engine.deleteThread({threadId:f.run.threadId},async file=>fs.renameSync(file,path.join(trash,path.basename(file))));
 assert(!fs.existsSync(recordPath));assert.equal(fs.readFileSync(artifact,'utf8'),'keep');assert(fs.existsSync(path.join(trash,path.basename(recordPath))));
});

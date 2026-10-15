'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {readOfficialConversation,vendorProjectDirectory}=require('../lib/session-conversations.cjs');
const sid='01234567-89ab-4cde-8fab-0123456789ab',at='2026-10-15T08:00:00.000Z';
function fixture(t,providerId='codex'){
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-official-session-')));t.after(()=>fs.rmSync(home,{force:true,recursive:true}));const workspace=path.join(home,'workspace');fs.mkdirSync(workspace);
 const options={providerId,sessionId:sid,workspace,home,codexHome:path.join(home,'.codex'),startedAt:at,finishedAt:'2026-10-15T08:00:15.000Z'};
 const file=providerId==='codex'?path.join(home,'.codex/sessions/2026/10/15/rollout-test-'+sid+'.jsonl'):path.join(home,'.codebuddy/projects',vendorProjectDirectory(workspace),sid+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
 let rows=providerId==='codex'?[
  {type:'session_meta',payload:{id:sid,cwd:workspace,source:'exec'}},{type:'event_msg',payload:{type:'task_started'}},
  {type:'turn_context',payload:{cwd:workspace,model:'actual-model',effort:'high'}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Context'}]}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Actual user prompt'}]}},
  {type:'response_item',payload:{type:'reasoning',content:[{type:'text',text:'NEVER EXPOSE REASONING'}]}},
  {type:'response_item',payload:{type:'message',id:'public-1',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Public activity'}]}},
  {type:'response_item',payload:{type:'message',id:'public-2',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Public final'}]}}
 ]:[{type:'message',sessionId:sid,cwd:workspace,role:'user',content:[{type:'input_text',text:'Actual user prompt'}]},
 {type:'message',sessionId:sid,cwd:workspace,role:'assistant',id:'wb-public',status:'completed',providerData:{model:'actual-wb-model',accessToken:'DO NOT EXPOSE'},content:[{type:'thinking',text:'NEVER EXPOSE REASONING'},{type:'output_text',text:'Public final'}]}];
 const write=()=>fs.writeFileSync(file,rows.map(row=>JSON.stringify({timestamp:providerId==='codex'?at:Date.parse(at),...row})).join('\n'));write();return {options,file,rows,write};
}
test('exact Codex exec session supplies actual input, public messages and turn model without reasoning',t=>{
 const f=fixture(t);const result=readOfficialConversation({...f.options,expectedPrompt:'Actual user prompt'});assert(result);assert.equal(result.input,'Actual user prompt');assert.equal(result.output,'Public final');assert.equal(result.actualModelId,'actual-model');assert.equal(result.messages.length,2);assert.equal(result.origin,'official-cli-log');assert.doesNotMatch(JSON.stringify(result),/REASONING|Context/);
 assert.equal(readOfficialConversation({...f.options,expectedPrompt:'Different prompt'}),null);
});
test('wrong session/workspace/time or multi-turn ambiguity never attributes another conversation',t=>{
 const f=fixture(t);f.rows[0].payload.id='11234567-89ab-4cde-8fab-0123456789ab';f.write();assert.equal(readOfficialConversation(f.options),null);
 f.rows[0].payload.id=sid;f.rows.push({type:'event_msg',payload:{type:'task_started'}});f.write();assert.equal(readOfficialConversation(f.options),null);
 f.rows.pop();f.write();assert.equal(readOfficialConversation({...f.options,startedAt:'2026-10-16T00:00:00Z',finishedAt:'2026-10-16T00:01:00Z'}),null);
});
test('WorkBuddy numeric timestamps and public model metadata are supported without exporting providerData',t=>{
 const f=fixture(t,'workbuddy'),result=readOfficialConversation(f.options);assert(result);assert.equal(result.input,'Actual user prompt');assert.equal(result.actualModelId,'actual-wb-model');assert.equal(result.messages[0].time,at);assert.doesNotMatch(JSON.stringify(result),/REASONING|accessToken|DO NOT EXPOSE/);
});
test('vendor project folders encode Windows drives and preserve byte-safe long Unicode paths',()=>{
 assert.equal(vendorProjectDirectory('C:\\Users\\Alice\\one--two'), 'C-Users-Alice-one-two');
 assert.equal(vendorProjectDirectory('/Users/Alice/project'), 'Users-Alice-project');
 const value=vendorProjectDirectory('C:\\Users\\Alice\\'+'测试目录'.repeat(90));
 assert(Buffer.byteLength(value,'utf8')<=255);assert(!/[\\/:\ufffd]/.test(value));assert.match(value,/-[a-z0-9]+$/);
});
test('symlinked, malformed and unknown sessions fail closed without a broad fallback search',t=>{
 const f=fixture(t);const outside=f.file+'.outside';fs.renameSync(f.file,outside);fs.symlinkSync(outside,f.file);assert.equal(readOfficialConversation(f.options),null);
 assert.equal(readOfficialConversation({...f.options,sessionId:'../../auth'}),null);fs.unlinkSync(f.file);fs.writeFileSync(f.file,'not json');assert.equal(readOfficialConversation(f.options),null);
});

'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {ConversationStore,MAX_CONVERSATION_TEXT_BYTES:LIMIT}=require('../lib/conversations.cjs');
const runId='01234567-89ab-4cde-8fab-0123456789ab',attemptId='11234567-89ab-4cde-8fab-0123456789ab';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-conversations-'));t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));let known=true;
  const store=new ConversationStore({dataDir:dir,validate:ids=>known&&ids.runId===runId&&(ids.stageId===undefined||ids.stageId==='starter')&&(ids.attemptId===undefined||ids.attemptId===attemptId)});
  return {dir,store,ids:{runId,stageId:'starter',attemptId},forget:()=>{known=false;}};}
test('actual conversation persists independently with private permissions and public whitelist',t=>{
 const f=fixture(t);const saved=f.store.save({...f.ids,input:'Actual input',output:'Actual final',providerId:'api-test',modelId:'chosen',actualModelId:'returned',effort:'high',sessionId:'public-session',origin:'provider',status:'completed',
  usage:{input:8,output:4,cacheRead:3,costUSD:null},apiKey:'never-store-this',thinking:'private-thought',
  messages:[{id:'one',role:'assistant',text:'Public first',time:'2026-10-15T00:00:00Z',thinking:'private-thought'},{role:'tool',text:'raw arguments'}],activities:[{type:'activity',message:'Read file',raw:{secret:'bad'}}]});
 assert.equal(saved.inputCaptured,true);assert.equal(saved.messages.length,1);assert.equal(saved.actualModelId,'returned');
 assert.doesNotMatch(JSON.stringify(saved),/never-store|private-thought|raw arguments|secret/);
 const file=fs.readdirSync(f.store.runPath(runId)).find(x=>x.endsWith('.json'));const target=path.join(f.store.runPath(runId),file);
 if(process.platform!=='win32'){assert.equal(fs.statSync(f.store.root).mode&0o777,0o700);assert.equal(fs.statSync(f.store.runPath(runId)).mode&0o777,0o700);assert.equal(fs.statSync(target).mode&0o777,0o600);}
 assert.deepEqual(f.store.get(f.ids),saved);assert.equal(fs.existsSync(path.join(f.dir,'runs')),false);
 const metadata=f.store.metadata(f.ids);assert.deepEqual(metadata,{actualModelId:'returned',modelId:'chosen',providerId:'api-test'});metadata.actualModelId='tampered';assert.equal(f.store.metadata(f.ids).actualModelId,'returned');
 const reopened=new ConversationStore({dataDir:f.dir,validate:()=>true});assert.equal(reopened.metadata(f.ids),null);assert.deepEqual(reopened.get(f.ids),saved);assert.deepEqual(reopened.metadata(f.ids),{actualModelId:'returned',modelId:'chosen',providerId:'api-test'});
});
test('unknown run/stage/attempt and traversal never disclose another record',t=>{
 const f=fixture(t);f.store.save({...f.ids,input:'real',output:'real'});
 for(const patch of [{runId:'../../escape'},{stageId:'../../escape'},{attemptId:'../../escape'},{stageId:'other'},{attemptId:'21234567-89ab-4cde-8fab-0123456789ab'}])assert.throws(()=>f.store.get({...f.ids,...patch}),/不存在/);
 f.forget();assert.throws(()=>f.store.get(f.ids),/不存在/);assert.throws(()=>f.store.runPath(runId),/不存在/);
});
test('legacy records never invent an input and missing files return null',t=>{
 const f=fixture(t);assert.equal(f.store.get(f.ids),null);
 const saved=f.store.save({...f.ids,output:'historic reply',legacy:true,inputCaptured:false});assert.equal(saved.input,null);assert.equal(saved.inputCaptured,false);
});
test('oversized input/output or public message history fail without replacing prior record',t=>{
 const f=fixture(t);const old=f.store.save({...f.ids,input:'real input',output:'real output'});
 for(const patch of [{input:'a'.repeat(LIMIT+1)},{output:'a'.repeat(LIMIT+1)},{messages:[{role:'assistant',text:'a'.repeat(LIMIT)},{role:'assistant',text:'b'}]}])assert.throws(()=>f.store.save({...f.ids,...patch}),/上限/);
 assert.deepEqual(f.store.get(f.ids),old);assert.ok(fs.readdirSync(f.store.runPath(runId)).every(x=>x.endsWith('.json')));
});
test('run-directory and record symlink replacements cannot read or write outside storage',t=>{
 const f=fixture(t);f.store.save({...f.ids,input:'test',output:'safe'});const dir=f.store.runPath(runId),file=path.join(dir,fs.readdirSync(dir)[0]);const outside=path.join(f.dir,'outside.json');fs.writeFileSync(outside,'private outside');
 fs.unlinkSync(file);fs.symlinkSync(outside,file);assert.throws(()=>f.store.get(f.ids),/不可读取/);assert.throws(()=>f.store.save({...f.ids,input:'overwrite'}),/不可读取|已被替换/);assert.equal(fs.readFileSync(outside,'utf8'),'private outside');
 fs.unlinkSync(file);fs.rmdirSync(dir);fs.symlinkSync(f.dir,dir,process.platform==='win32'?'junction':'dir');assert.throws(()=>f.store.save({...f.ids,input:'overwrite'}),/被替换/);
});
test('credential-like text is redacted and tampered disk fields never reach renderer',t=>{
 const f=fixture(t);f.store.save({...f.ids,input:'Authorization: Bearer synthetic-credential',output:'password=synthetic-password'});
 const dir=f.store.runPath(runId),file=path.join(dir,fs.readdirSync(dir)[0]);const raw=JSON.parse(fs.readFileSync(file));raw.apiKey='synthetic-key';raw.messages=[{role:'assistant',text:'Public',toolArguments:'private'}];fs.writeFileSync(file,JSON.stringify(raw));
 const actual=f.store.get(f.ids);assert.doesNotMatch(JSON.stringify(actual),/synthetic-credential|synthetic-password|synthetic-key|toolArguments/);assert.equal(actual.messages[0].text,'Public');
});

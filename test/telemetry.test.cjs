'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {Telemetry,normalizeObservedModels,normalizeRecentCalls,taskUsageCalls}=require('../lib/telemetry.cjs');
const root=path.resolve(__dirname,'..');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-telemetry-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function write(dir,name,body){const p=path.join(dir,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body);return p;}

test('recent usage is a de-duplicated timestamped sample; unknown cache and unrelated private fields stay unavailable',()=>{
  const now=Date.parse('2026-10-15T12:00:00Z'),time=new Date(now-1000).toISOString();
  const row={id:'message-1',providerId:'codex',modelId:'openai::gpt-alpha',time,scope:'software',usage:{input:12,output:3,cacheRead:null},content:'PRIVATE'};
  const calls=normalizeRecentCalls([row,row,{...row,id:'future',time:new Date(now+1000).toISOString()},
    {...row,id:'old',time:new Date(now-7*86400000-1).toISOString()}, {...row,id:'bad',modelId:'sk-secret123456789000'}],{now});
  assert.equal(calls.length,1);assert.equal(calls[0].usage.cacheRead,null);assert.equal(calls[0].usage.input,12);
  assert.equal(calls[0].time,time);assert(!JSON.stringify(calls).includes('PRIVATE'));assert.match(calls[0].id,/^[a-f0-9]{64}$/);
});

test('task series attributes retries to their captured models and separates DSH routes from software samples',()=>{
  const time='2026-10-15T12:00:00Z';
  const rows=taskUsageCalls([{id:'run',stages:[{id:'execute',provider:'dsh',model:'wrong-after-switch',attempts:[
    {id:'legacy',startedAt:time,usage:{input:999}},
    {id:'one',providerId:'dsh',modelId:'workbuddy-ai::hy3',actualModelId:'hy3',startedAt:time,usage:{input:10}},
    {id:'two',providerId:'dsh',modelId:'deepseek-flash',startedAt:time,usage:{input:2,cacheRead:0}}
  ]}]}]);
  assert.equal(rows.length,2);assert.equal(rows[0].modelId,'workbuddy-ai::hy3');assert.equal(rows[0].scope,'task');
  assert.equal(rows[0].usage.cacheRead,null);assert.equal(rows[1].usage.cacheRead,0);assert(!JSON.stringify(rows).includes('wrong-after-switch'));
});

test('observed telemetry models retain only exact current-day metadata and their own usage',()=>{
  const raw=[{id:'workbuddy-ai::hy3',label:'workbuddy-ai · hy3',providerRoute:'workbuddy-ai',window:'today',
    usage:{input:100,output:5,cacheRead:null},prompt:'TRANSCRIPT',account:'IDENTITY',apiKey:'SECRET'},
    {id:'workbuddy-ai::hy3',window:'today',usage:{input:999}},
    {id:'catalog-only'}, {id:'yesterday-model',window:'week'}, {id:'sk-secret1234567890',window:'today'},
    {id:'bad\nmodel',window:'today'}, {id:'未知模型',window:'today'}];
  const models=normalizeObservedModels(raw);
  assert.equal(models.length,1);assert.equal(models[0].id,'workbuddy-ai::hy3');
  assert.equal(models[0].usage.input,100);assert.equal(models[0].usage.cacheRead,null);
  assert(!JSON.stringify(models).match(/TRANSCRIPT|IDENTITY|SECRET|999/));
  assert.deepEqual(normalizeObservedModels(undefined),[]);
});

test('telemetry bridge exports per-model usage without copying the provider total or private fields',async t=>{
  const dir=fixture(t);const helper=write(dir,'helper',`#!${process.execPath}\nconsole.log(JSON.stringify(${JSON.stringify({schemaVersion:1,providers:[{id:'dsh',name:'DeepSeek Harness',usage:{input:999,output:40},models:[{id:'workbuddy-ai::hy3',window:'today',usage:{input:3,output:1},content:'TRANSCRIPT'}],account:'IDENTITY'}]})}));\n`);
  fs.chmodSync(helper,0o700);
  let telemetry;await new Promise((resolve,reject)=>{telemetry=new Telemetry({helper,platform:'darwin',onChange:resolve});telemetry.refresh();setTimeout(()=>reject(new Error('telemetry fixture timed out')),3000).unref();});
  t.after(()=>telemetry.stop());const sample=telemetry.get().tokenlens.providers[0];
  assert.equal(sample.usage.input,999);assert.equal(sample.models[0].usage.input,3);
  assert(!JSON.stringify(sample).match(/TRANSCRIPT|IDENTITY/));
});

test('Swift readers attribute current-day real model metadata, preserve DSH routes, and skip seeded replay',{
  skip:process.platform!=='darwin',timeout:120000
},async t=>{
  const dir=fixture(t),executable=path.join(dir,'reader-fixture');
  const sdk=fs.existsSync('/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk')?'/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk':execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim();
  const sources=fs.readdirSync(path.join(root,'lib/tokenlens-sources')).filter(n=>n.endsWith('.swift')&&n!=='TelemetryMain.swift').map(n=>path.join(root,'lib/tokenlens-sources',n));
  execFileSync('/usr/bin/swiftc',['-sdk',sdk,'-swift-version','6','-strict-concurrency=complete','-parse-as-library',...sources,path.join(__dirname,'telemetry-reader-fixture.swift'),'-o',executable],{timeout:90000,stdio:['ignore','pipe','pipe']});
  const now=new Date('2026-10-15T12:00:00Z'),iso=n=>new Date(now.getTime()+n*1000).toISOString();
  const codex=[{timestamp:iso(-86500),type:'session_meta',payload:{id:'fixture',model_provider:'openai'}},
    {timestamp:iso(-86500),type:'turn_context',payload:{model:'old-model'}},
    {timestamp:iso(-86500),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:10,total_tokens:110,cached_input_tokens:20}}}},
    {timestamp:iso(-300),type:'turn_context',payload:{model:'gpt-alpha'}},
    {timestamp:iso(-200),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:150,output_tokens:15,total_tokens:165,cached_input_tokens:30}}}},
    {timestamp:iso(-100),type:'turn_context',payload:{model:'gpt-beta'}},
    {timestamp:iso(-20),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:215,output_tokens:20,total_tokens:235,cached_input_tokens:45}}}}];
  write(dir,'sessions/a.jsonl',codex.map(x=>JSON.stringify(x)).join('\n')+'\n');
  write(dir,'sessions/fork-copy.jsonl',codex.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const wb=(id,time,model)=>({timestamp:time,sessionId:'fixture',providerData:{messageId:id,requestModelId:model,requestModelName:'display label',usage:{inputTokens:100,outputTokens:5,totalTokens:105,requests:1},rawUsage:{prompt_cache_hit_tokens:20}}});
  write(dir,'.workbuddy-ai/projects/test.jsonl',[wb('old',iso(-86500),'old-workbuddy'),wb('new',iso(-20),'actual-workbuddy-model')].map(x=>JSON.stringify(x)).join('\n')+'\n');
  write(dir,'support/Claude/local-agent-mode-sessions/test.jsonl',JSON.stringify({type:'assistant',timestamp:iso(-20),sessionId:'fixture',message:{id:'c1',model:'claude-actual',content:[{type:'text',text:'TRANSCRIPT'}],usage:{input_tokens:2,output_tokens:1,cache_read_input_tokens:3,cache_creation_input_tokens:4}}})+'\n');
  write(dir,'support/CodeBuddyExtension/Data/history/test.json',JSON.stringify({requests:[{id:'cb1',startedAt:iso(-20),usage:{inputTokens:1,outputTokens:1,totalTokens:2}}]}));
  const output=execFileSync(executable,[dir,String(now.getTime()/1000)],{encoding:'utf8',timeout:15000});
  assert(!output.includes('TRANSCRIPT'));const got=JSON.parse(output);
  assert.deepEqual(got.codex.sort((a,b)=>a.model.localeCompare(b.model)).map(x=>[x.model,x.input,x.output,x.cacheRead]),[['gpt-alpha',50,5,10],['gpt-beta',65,5,15]]);
  assert.equal(got.codexCalls.length,2);assert.equal(got.codexCalls.reduce((n,c)=>n+c.input,0),115);
  assert(got.codexCalls.every(c=>c.time<=now.getTime()/1000&&c.reasoningKnown===false));
  assert.equal(got.workbuddyCalls,2);assert.deepEqual(got.claudeCalls,[{model:'claude-actual',write:4,writeKnown:true}]);
  assert.deepEqual(got.workbuddy.map(x=>[x.model,x.input]),[['actual-workbuddy-model',100]]);
  assert.deepEqual(got.claude.map(x=>[x.model,x.input,x.cacheRead]),[['claude-actual',9,3]]);
  assert.deepEqual(got.codebuddy,[]);
  assert.deepEqual(got.dsh.map(x=>[x.provider,x.model,x.input,x.cacheKnown]),[['workbuddy-ai','hy3',100,false],['workbuddy','hy3',37,true]]);
  assert.equal(got.seededBefore,0);assert.equal(got.seededAfter,1);assert.equal(got.seededInput,3);
});

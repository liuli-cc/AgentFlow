'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createCodeBuddyInvocation,codeBuddyEnvironment,inspectCodeBuddyAuth,inspectCodeBuddyCatalog,authenticateCodeBuddy}=require('../lib/codebuddy-auth.cjs');

async function fixture(t,mode='success'){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agentflow-codebuddy-auth-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const packageDir=path.join(dir,'node_modules','@tencent-ai','codebuddy-code');
  const cliPath=path.join(packageDir,'bin','codebuddy');const log=path.join(dir,'methods.jsonl');
  await fs.mkdir(path.dirname(cliPath),{recursive:true});
  await fs.writeFile(path.join(packageDir,'package.json'),JSON.stringify({name:'@tencent-ai/codebuddy-code',version:'2.167.0'}));
  await fs.writeFile(cliPath,`
const readline=require('node:readline'),fs=require('node:fs');
const log=${JSON.stringify(log)},mode=${JSON.stringify(mode)};
function out(x){process.stdout.write(JSON.stringify(x)+'\\n')}
process.stderr.write('secret-canary https://oauth.example/callback?token=secret-canary\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(x)+'\\n');
 if(x.method==='initialize'){
  if(mode==='overflow')return process.stdout.write('secret-canary'.repeat(200000));
  if(mode==='request')out({jsonrpc:'2.0',id:90,method:'fs/read_text_file',params:{path:'/private'}});
  if(mode==='hang')return;
  out({jsonrpc:'2.0',id:x.id,result:{protocolVersion:1,authMethods:[
   {id:'internal',name:'untrusted secret-canary',_meta:{token:'secret-canary'}},
   {id:'external',name:'untrusted'}, {id:'selfhosted',name:'Enterprise'}, {id:'injected',name:'Malicious'}
  ],_meta:{token:'secret-canary'},agentCapabilities:{secret:'secret-canary'}}});
 }
 if(x.method==='authenticate'){
  if(mode==='auth-hang')return;
  if(mode==='failure')return out({jsonrpc:'2.0',id:x.id,error:{code:-32000,message:'secret-canary https://oauth.example/?token=secret-canary',data:{accessToken:'secret-canary'}}});
  out({jsonrpc:'2.0',id:x.id,result:{_meta:{'codebuddy.ai/userinfo':{userId:'private-user',accessToken:'secret-canary'}}}});
 }
 if(x.method==='session/new'){
  if(mode==='noauth')return out({jsonrpc:'2.0',id:x.id,error:{code:-32000,message:'secret-canary',data:{category:'auth'}}});
  if(mode==='catalog-failure')return out({jsonrpc:'2.0',id:x.id,error:{code:-32000,message:'secret-canary',data:{category:'network'}}});
  out({jsonrpc:'2.0',id:x.id,result:{sessionId:'private-session',models:{currentModelId:'hy3',availableModels:[
   {modelId:'hy3',name:'HY 3',_meta:{token:'secret-canary'}},{modelId:'deepseek-v4.1-flash',name:'DeepSeek'},
   {modelId:'https://bad/?token=secret-canary',name:'bad'},{modelId:'hy3',name:'duplicate'}]},
   configOptions:[{id:'thought_level',type:'select',options:[{value:'low'},{value:'high'},{value:'injected'}]}],
   _meta:{accessToken:'secret-canary'}}});
 }
});
`);
  return {dir,cliPath,nodePath:process.execPath,cwd:dir,env:{HOME:dir,PATH:process.env.PATH},log};
}

test('official invocation is bounded, tool-free, no shell or inherited credential overrides',async t=>{
  const f=await fixture(t);const x=createCodeBuddyInvocation({...f,methodId:'internal',env:{...f.env,
    CODEBUDDY_API_KEY:'secret',CODEBUDDY_AUTH_TOKEN:'secret',NODE_OPTIONS:'--require bad',CODEBUDDY_BASE_URL:'https://bad',
    CODEBUDDY_CONFIG_DIR:path.join(f.dir,'config')}});
  assert.equal(x.shell,false);assert.equal(x.command,process.execPath);
  assert.deepEqual(x.args.slice(1),['--acp','--acp-transport','stdio','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','none','--no-session-persistence']);
  assert.equal(x.env.CODEBUDDY_INTERNET_ENVIRONMENT,'internal');assert.equal(x.env.DISABLE_AUTOUPDATER,'1');
  assert.equal(x.env.CODEBUDDY_DISABLE_PRODUCT_CACHE,'1');
  assert.equal(x.env.CODEBUDDY_CONFIG_DIR,path.join(f.dir,'config'));
  for(const key of ['CODEBUDDY_API_KEY','CODEBUDDY_AUTH_TOKEN','NODE_OPTIONS','CODEBUDDY_BASE_URL'])assert.equal(x.env[key],undefined);
  assert.equal(codeBuddyEnvironment({CODEBUDDY_CONFIG_DIR:'relative'}).CODEBUDDY_CONFIG_DIR,undefined);
});

test('both login regions reject a stale WorkBuddy product and inherited opposite-region configuration',()=>{
  const dirty={HOME:'/tmp/agentflow-test',PATH:process.env.PATH,CODEBUDDY_DISABLE_PRODUCT_CACHE:'0',
    CODEBUDDY_INTERNET_ENVIRONMENT:'external',CODEBUDDY_INTERNET_ENVIROMENT:'external',
    ACC_PRODUCT_CONFIG_V3:'{"platform":"workbuddy","endpoint":"https://www.workbuddy.ai"}',
    ACC_PRODUCT_CONFIG_PATH:'/tmp/workbuddy-product.json',CODEBUDDY_HOST:'workbuddy-desktop',
    CODEBUDDY_FORCE_LITE_WB_BUNDLE:'1',BROWSER:'malicious-browser'};
  const domestic=codeBuddyEnvironment(dirty,{methodId:'internal'});
  const international=codeBuddyEnvironment({...dirty,CODEBUDDY_INTERNET_ENVIRONMENT:'internal'},{methodId:'external'});
  assert.equal(domestic.CODEBUDDY_INTERNET_ENVIRONMENT,'internal');
  assert.equal(international.CODEBUDDY_INTERNET_ENVIRONMENT,'external');
  for(const actual of [domestic,international]){
    assert.equal(actual.CODEBUDDY_DISABLE_PRODUCT_CACHE,'1');
    for(const key of ['CODEBUDDY_INTERNET_ENVIROMENT','ACC_PRODUCT_CONFIG_V3','ACC_PRODUCT_CONFIG_PATH',
      'CODEBUDDY_HOST','CODEBUDDY_FORCE_LITE_WB_BUNDLE','BROWSER'])assert.equal(actual[key],undefined);
    assert.doesNotMatch(JSON.stringify(actual),/workbuddy/i);
  }
});

test('inspection only initializes and returns fixed public auth methods without identity or token',async t=>{
  const f=await fixture(t);const result=await inspectCodeBuddyAuth(f);
  assert.deepEqual(result,{protocolVersion:1,packageVersion:'2.167.0',authMethods:[{id:'internal',name:'国内账号 · 微信'},{id:'external',name:'国际账号 · Google / GitHub'}]});
  assert.doesNotMatch(JSON.stringify(result),/secret|private-user|untrusted|selfhosted/);
  const lines=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(x=>x.method),['initialize']);
  assert.deepEqual(lines[0].params.clientCapabilities,{fs:{readTextFile:false,writeTextFile:false},terminal:false});
});

test('explicit authenticate uses selected advertised region and discards the entire auth response',async t=>{
  const f=await fixture(t);let started;
  const result=await authenticateCodeBuddy({...f,methodId:'external',onStarted:value=>{started=value;}});
  assert.deepEqual(result,{authenticated:true,methodId:'external'});
  assert.deepEqual(started,{started:true,kind:'browser-cli',methodId:'external'});
  const lines=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(x=>x.method),['initialize','authenticate']);
  assert.deepEqual(lines[1].params,{methodId:'external'});
  assert.doesNotMatch(JSON.stringify({result,started}),/secret|private-user|userinfo|token/);
});

test('catalog reads only an empty non-persistent session and exposes public model fields',async t=>{
  const f=await fixture(t);const result=await inspectCodeBuddyCatalog(f);
  assert.deepEqual(result,{authenticated:true,executionVerified:false,defaultModelId:'hy3',source:'codebuddy-acp-session',models:[
    {id:'hy3',label:'HY 3',efforts:['default','low','high'],source:'codebuddy-acp-session'},
    {id:'deepseek-v4.1-flash',label:'DeepSeek',efforts:['default'],source:'codebuddy-acp-session'}]});
  assert.doesNotMatch(JSON.stringify(result),/secret|private|sessionId|_meta|https/);
  const lines=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(x=>x.method),['initialize','session/new']);
  assert.deepEqual(lines[1].params,{cwd:f.cwd,mcpServers:[]});
});

test('only exact ACP auth-required category becomes a safe unauthenticated state',async t=>{
  const noauth=await fixture(t,'noauth');
  assert.deepEqual(await inspectCodeBuddyCatalog(noauth),{authenticated:false,executionVerified:false,defaultModelId:null,models:[],source:'codebuddy-acp-session'});
  const failure=await fixture(t,'catalog-failure');
  await assert.rejects(inspectCodeBuddyCatalog(failure),error=>{assert.equal(error.message,'CodeBuddy 模型目录暂不可用');return true;});
});

test('errors are fixed messages and never forward OAuth URLs, identities or tokens',async t=>{
  const f=await fixture(t,'failure');
  await assert.rejects(authenticateCodeBuddy({...f,methodId:'internal'}),error=>{
    assert.equal(error.message,'CodeBuddy 官方登录未完成，请重试');
    assert.doesNotMatch(String(error),/secret|https|token|user/);return true;
  });
});

test('arbitrary server requests receive a denial and never execute or reach caller',async t=>{
  const f=await fixture(t,'request');await authenticateCodeBuddy({...f,methodId:'internal'});
  const lines=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.find(x=>x.id===90),{jsonrpc:'2.0',id:90,error:{code:-32601,message:'Method not supported'}});
  assert.ok(lines.every(x=>!['getUserInfo','session/new','session/prompt'].includes(x.method)));
});

test('unknown or missing region, relative or wrong package paths never spawn',async t=>{
  const f=await fixture(t);let spawned=false;const spawnImpl=()=>{spawned=true;throw new Error('must not spawn');};
  await assert.rejects(authenticateCodeBuddy({...f,methodId:'injected',spawnImpl}),/登录区域/);
  await assert.rejects(authenticateCodeBuddy({...f,spawnImpl}),/登录区域/);
  await assert.rejects(inspectCodeBuddyAuth({...f,cliPath:'relative',spawnImpl}),/路径无效/);
  await fs.writeFile(path.join(path.dirname(path.dirname(f.cliPath)),'package.json'),'{"name":"fake","version":"2.167.0"}');
  await assert.rejects(inspectCodeBuddyAuth({...f,spawnImpl}),/官方命令行组件/);
  assert.equal(spawned,false);
});

test('cancel before spawn and while waiting for browser completion is bounded',async t=>{
  const f=await fixture(t,'auth-hang');const early=new AbortController();early.abort();let spawned=false;
  await assert.rejects(authenticateCodeBuddy({...f,methodId:'internal',signal:early.signal,spawnImpl:()=>{spawned=true;}}),{name:'AbortError'});
  assert.equal(spawned,false);
  const controller=new AbortController();
  await assert.rejects(authenticateCodeBuddy({...f,methodId:'internal',signal:controller.signal,onStarted:()=>controller.abort()}),{name:'AbortError'});
});

test('timeout and oversized output are rejected without forwarding raw output',async t=>{
  const f=await fixture(t,'hang');const begin=Date.now();
  await assert.rejects(inspectCodeBuddyAuth({...f,timeoutMs:1000}),/检测超时/);assert.ok(Date.now()-begin<4000);
  const big=await fixture(t,'overflow');
  await assert.rejects(inspectCodeBuddyAuth(big),error=>{assert.match(error.message,/超出限制/);assert.doesNotMatch(String(error),/secret/);return true;});
});

test('a closed child never receives delayed SIGKILL for a potentially reused pid',async t=>{
  const f=await fixture(t);const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
  const child=new EventEmitter();Object.assign(child,{pid:1234567,exitCode:null,signalCode:null,stdin:new PassThrough(),stdout:new PassThrough()});
  const kills=[];
  child.stdin.on('data',data=>{
    const x=JSON.parse(String(data));if(x.method==='initialize')process.nextTick(()=>child.stdout.write(JSON.stringify({id:1,result:{protocolVersion:1,authMethods:[]}})+'\n'));
  });
  await inspectCodeBuddyAuth({...f,spawnImpl:()=>child,killImpl:(pid,signal)=>{
    kills.push(signal);child.signalCode=signal;child.emit('exit',null,signal);child.emit('close',null,signal);
  }});
  await new Promise(resolve=>setTimeout(resolve,600));assert.deepEqual(kills,['SIGTERM']);
});

test('successful ACP metadata waits for the owned process close before returning its temporary workspace',async t=>{
  const f=await fixture(t),{spawn}=require('node:child_process');let closed=false;
  await inspectCodeBuddyAuth({...f,spawnImpl:(command,args,options)=>{
    const child=spawn(command,args,options);child.once('close',()=>{closed=true;});return child;
  }});
  assert.equal(closed,true,'caller cleanup must only run after process handles release the cwd');
});

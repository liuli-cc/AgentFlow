'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {describeAuth,createAuthInvocation,authEnvironment}=require('../lib/auth.cjs');
test('Codex and Claude use only their fixed official browser-login commands',()=>{
  for(const [id,executable,args]of [['codex','/Applications/ChatGPT.app/Contents/Resources/codex',['login']],['claude','/Users/test/.local/bin/claude',['auth','login','--claudeai']]]){
    const provider={id,mode:'cli',executable,ready:false};assert.equal(describeAuth(provider,{platform:'darwin'}).kind,'browser-cli');
    const invocation=createAuthInvocation(provider,{nodePath:'/bin/sh',platform:'darwin'});assert.equal(invocation.command,executable);assert.deepEqual(invocation.args,args);
    assert.equal(invocation.args.includes('--with-api-key'),false);assert.equal(invocation.args.includes('--with-access-token'),false);
    assert.equal(Object.hasOwn(invocation,'stdin'),false);
  }
});
test('authentication environment carries runtime paths but no provider API keys or arbitrary execution hooks',()=>{
  const environment={HOME:'/Users/test',PATH:'/usr/bin',CODEX_HOME:'/Users/test/.codex',CLAUDE_CONFIG_DIR:'/Users/test/.claude',OPENAI_API_KEY:'do-not-copy',ANTHROPIC_AUTH_TOKEN:'do-not-copy',NODE_OPTIONS:'--require malicious',ELECTRON_RUN_AS_NODE:'1',UNRELATED_SECRET:'private'};
  assert.deepEqual(authEnvironment('codex',environment),{HOME:'/Users/test',PATH:'/usr/bin',CODEX_HOME:'/Users/test/.codex'});
  assert.deepEqual(authEnvironment('claude',environment),{HOME:'/Users/test',PATH:'/usr/bin',CLAUDE_CONFIG_DIR:'/Users/test/.claude'});
});
test('desktop login delegates to the original application and never changes execution readiness',()=>{
  for(const [id,appPath]of [['dsh','/Applications/DeepSeek Harness.app'],['opencode','/Users/test/Applications/OpenCode.app'],['marvis','/Applications/Marvis.app'],['doubao','/Applications/Doubao.app']]){
    const provider={id,name:id,installed:true,ready:false,mode:'handoff',appPath};const description=describeAuth(provider,{platform:'darwin'});
    assert.equal(description.kind,'desktop');assert.equal(description.executionReady,false);assert.equal(description.state,'unknown');assert.equal(description.browserFlow,false);
    const invocation=createAuthInvocation(provider,{platform:'darwin'});assert.equal(invocation.command,'/usr/bin/open');assert.deepEqual(invocation.args,['-a',appPath]);assert.equal(provider.ready,false);
  }
});
test('unknown executables, API records and injected or relative paths cannot become a login command',()=>{
  for(const provider of [
    {id:'codex',mode:'cli',executable:'/bin/sh'},
    {id:'claude',mode:'cli',executable:'claude'},
    {id:'claude',mode:'cli',executable:'/tmp/claude\nmalicious'},
    {id:'api-test',mode:'api',installed:true,appPath:'/Applications/Other.app',ready:true},
    {id:'shell',mode:'cli',executable:'/bin/sh',installed:true,appPath:'/Applications/Other.app'},
    {id:'doubao',mode:'handoff',installed:true,appPath:'../Doubao.app'},
    {id:'marvis',mode:'handoff',installed:true,appPath:'/Applications/Marvis.app\n--args'},
  ])assert.throws(()=>createAuthInvocation(provider,{platform:'darwin'}),/官方登录入口/);
});
test('newly discovered installed applications get only a desktop action and public metadata',()=>{
  const provider={id:'app-0123456789abcdef0123',name:'Installed app',installed:true,mode:'handoff',appPath:'/Applications/Installed AI.app',apiKey:'private-value',token:'never-return',env:{SECRET:'private'}};
  const result=describeAuth(provider,{platform:'darwin'});assert.equal(result.kind,'desktop');assert.equal(result.executionReady,false);
  assert(!JSON.stringify(result).includes('private'));assert(!JSON.stringify(result).includes('never-return'));assert.equal(Object.hasOwn(result,'env'),false);
});

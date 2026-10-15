'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { detectProviders, buildInvocation, runProvider, probeProvider, applyProviderVerification, enrichCodeBuddyProvider } = require('../lib/providers.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-provider-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let serial = 0;
  function script(source, id = 'codex') {
    const executable = path.join(directory, `provider-${serial++}.cjs`);
    fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
    return { id, name: id, mode: 'cli', executable };
  }
  function events(values, { id = 'codex', exit = 0, suffix = '' } = {}) {
    return script(`process.stdin.resume(); process.stdin.on('end', () => {
      ${values.map(value => `console.log(${JSON.stringify(JSON.stringify(value))});`).join('\n')}
      ${suffix}
      process.exitCode = ${exit};
    });`, id);
  }
  return { directory, script, events };
}

const complete = usage => ({ type: 'turn.completed', usage });
const dshEnd = { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } };

test('Doubao desktop detection preserves the handoff boundary without inventing a model API or usage', async t => {
  const f = fixture(t);
  // Detection only performs installed-file and CLI login/help checks; no model invocation.
  const doubao = detectProviders({ platform:'darwin', home: f.directory }).find(provider => provider.id === 'doubao');
  assert(doubao);
  assert.equal(doubao.name, '豆包');
  assert.equal(doubao.appPath, '/Applications/Doubao.app');
  assert.equal(doubao.installed, fs.existsSync('/Applications/Doubao.app'));
  assert.equal(doubao.mode, 'handoff');
  assert.equal(doubao.ready, false);
  assert.equal(doubao.executable, null);
  assert.equal(doubao.authStatus, 'client-managed');
  assert.equal(doubao.adapterStatus, 'unavailable');
  assert.equal(doubao.readinessReason.code, 'adapter-unavailable');
  assert.match(doubao.readinessReason.message, /不代表你没有登录/);
  assert.equal(doubao.models.length, 1);
  assert.equal(doubao.models[0].id, 'default');
  assert.equal(doubao.models[0].label, '跟随豆包客户端');
  assert.equal(doubao.models[0].availability, 'client-managed');
  assert.deepEqual(doubao.efforts, ['default']);
  assert.match(doubao.message, /用量回传/);
  assert.match(doubao.message, /未知/);
  assert.throws(() => buildInvocation({ provider: doubao, prompt: 'do not run', workspace: f.directory }), /手动交接/);
  await assert.rejects(runProvider({ provider: doubao, prompt: 'do not run', workspace: f.directory }), /手动交接/);
  await assert.rejects(probeProvider({ provider: doubao }), /没有已验证的禁工具连接检测/);
  const marvis = detectProviders({ platform:'darwin', home: f.directory }).find(provider => provider.id === 'marvis');
  assert.equal(marvis.authStatus, 'client-managed');assert.equal(marvis.adapterStatus, 'unavailable');
  assert.equal(marvis.readinessReason.code, 'adapter-unavailable');assert.equal(marvis.ready, false);
});

test('OpenCode reads the original shared service catalog while free native-only models remain unavailable', t => {
  const f=fixture(t),app=path.join(f.directory,'Applications/OpenCode.app'),bin=path.join(app,'Contents/Resources/opencode-cli');
  fs.mkdirSync(path.dirname(bin),{recursive:true});
  const capture=path.join(f.directory,'calls.jsonl');
  fs.writeFileSync(bin,`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');
    if(process.argv.includes('models'))console.log('opencode/big-pickle\\nopencode/deepseek-v4.1-flash-free\\nnot a model');
    else if(process.argv.includes('auth'))console.log('[]');else process.exitCode=77;`,{mode:0o700});
  const provider=detectProviders({ platform:'darwin', home:f.directory}).find(p=>p.id==='opencode');
  assert.equal(provider.serverContext,'shared-background-service');assert.equal(provider.cliAvailable,true);
  assert.equal(provider.ready,false);assert.equal(provider.authStatus,'client-managed');
  assert.equal(provider.readinessReason.code,'free-client-only');assert.match(provider.readinessReason.message,/原厂限制免费模型仅在原应用内使用/);
  assert.deepEqual(provider.models.map(m=>m.id),['opencode/big-pickle','opencode/deepseek-v4.1-flash-free']);
  assert(provider.models.every(m=>!m.ready&&m.availability==='client-only'));
  const calls=fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length,2);assert(calls.every(args=>!args.includes('--standalone')));
  const settings=path.join(f.directory,'Library/Application Support/ai.opencode.desktop/opencode.settings');fs.mkdirSync(path.dirname(settings),{recursive:true});
  fs.writeFileSync(settings,JSON.stringify({defaultServerUrl:'http://127.0.0.1:12345'}));
  const selected=detectProviders({ platform:'darwin', home:f.directory}).find(p=>p.id==='opencode');
  assert.equal(selected.serverContext,'desktop-selected-local-server');
  const selectedCalls=fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse).slice(-2);
  assert(selectedCalls.every(args=>args.includes('--server')&&args.includes('http://127.0.0.1:12345')));
  fs.writeFileSync(settings,JSON.stringify({defaultServerUrl:'https://identity:SYNTHETIC_SECRET@example.invalid/?token=SYNTHETIC_SECRET'}));
  const blocked=detectProviders({ platform:'darwin', home:f.directory}).find(p=>p.id==='opencode');
  assert.equal(blocked.readinessReason.code,'desktop-server-unavailable');
  assert.equal(fs.readFileSync(capture,'utf8').trim().split('\n').length,4);
  assert(!JSON.stringify(blocked).includes('SYNTHETIC_SECRET'));
});

test('OpenCode configured account metadata does not imply verified execution or disclose account rows',t=>{
  const f=fixture(t),bin=path.join(f.directory,'Applications/OpenCode.app/Contents/Resources/opencode-cli');fs.mkdirSync(path.dirname(bin),{recursive:true});
  fs.writeFileSync(bin,`#!${process.execPath}\nif(process.argv.includes('models'))console.log('anthropic/actual-model');else console.log(JSON.stringify([{provider:'anthropic',apiKey:'SYNTHETIC_PRIVATE_VALUE',identity:'SYNTHETIC_IDENTITY'}]));`,{mode:0o700});
  const provider=detectProviders({ platform:'darwin', home:f.directory}).find(p=>p.id==='opencode');
  assert.equal(provider.authStatus,'configured');assert.equal(provider.ready,false);assert.equal(provider.mode,'handoff');
  assert.equal(provider.readinessReason.code,'execution-unverified');assert.equal(provider.models[0].availability,'execution-unverified');
  assert(!JSON.stringify(provider).includes('SYNTHETIC_PRIVATE_VALUE'));assert(!JSON.stringify(provider).includes('SYNTHETIC_IDENTITY'));
});

test('Codex public messages retain every completed assistant item, deduplicate snapshots and omit reasoning',async t=>{
  const f=fixture(t),events=[];
  const provider=f.events([{type:'item.updated',item:{id:'item_1',type:'agent_message',text:'working'}},
    {type:'item.completed',item:{id:'item_1',type:'agent_message',text:'First public update'}},
    {type:'item.completed',item:{id:'item_1',type:'agent_message',text:'First public update'}},
    {type:'item.completed',item:{id:'thinking_1',type:'reasoning',text:'SYNTHETIC_PRIVATE_THINKING'}},
    {type:'item.completed',item:{id:'item_2',type:'agent_message',text:'Final answer'}},complete({})]);
  const result=await runProvider({provider,prompt:'x',workspace:f.directory,onEvent:event=>events.push(event)});
  assert.equal(result.text,'Final answer');
  assert.deepEqual(events.filter(e=>e.type==='message').map(e=>({id:e.id,text:e.text,role:e.role,final:e.final,messageCapture:e.messageCapture})),[
    {id:'item_1',text:'First public update',role:'assistant',final:true,messageCapture:'public-messages'},
    {id:'item_2',text:'Final answer',role:'assistant',final:true,messageCapture:'public-messages'}]);
  assert(events.some(e=>e.type==='text'&&e.text==='working'));
  assert(!JSON.stringify(events).includes('SYNTHETIC_PRIVATE_THINKING'));
});

test('Claude-compatible public messages and tool activity expose only whitelisted redacted fields',async t=>{
  const f=fixture(t);
  for(const id of ['claude','workbuddy','codebuddy']){
    const events=[],provider=f.events([
      {type:'assistant',message:{id:'msg_first',content:[{type:'thinking',thinking:'SYNTHETIC_THINKING'},{type:'text',text:'I will inspect the file.'},
        {type:'tool_use',name:'Read',input:{file_path:'/workspace/example.txt',pattern:'hello',headers:'SYNTHETIC_HEADER',content:'SYNTHETIC_BODY'}}]}},
      {type:'assistant',message:{id:'msg_last',content:[{type:'text',text:'Done.'},
        {type:'tool_use',name:'Bash',input:{command:'cat example.txt'}},
        {type:'tool_use',name:'Bash',input:{command:'curl https://example.invalid/private -H "X-Private: SYNTHETIC_HEADER"'}},
        {type:'tool_use',name:'Bash',input:{command:'API_TOKEN=SYNTHETIC_TOKEN echo request'}},
        {type:'tool_use',name:'CustomTool',input:{file_path:'SYNTHETIC_UNKNOWN_FIELD'}}]}},
      {type:'result',subtype:'success',is_error:false,result:'Done.',usage:{}}],{id});
    await runProvider({provider,prompt:'x',workspace:f.directory,nodePath:process.execPath,onEvent:event=>events.push(event)});
    assert.deepEqual(events.filter(e=>e.type==='message').map(e=>({id:e.id,text:e.text})),[
      {id:'msg_first',text:'I will inspect the file.'},{id:'msg_last',text:'Done.'}]);
    const tools=events.filter(e=>e.activity==='tool_call');assert.equal(tools.length,5);
    assert.match(tools[0].text,/Read.*example.txt.*pattern: hello/);assert.match(tools[1].text,/cat example.txt/);
    assert.equal(tools[4].text,'CustomTool');
    assert(!JSON.stringify(events).includes('SYNTHETIC_'));assert(!JSON.stringify(events).includes('https://'));
  }
});

test('DSH public message capture honestly emits only its completed final answer',async t=>{
  const f=fixture(t),events=[],provider=f.events([{type:'text',text:'Streaming public text'},dshEnd,{type:'final',text:'Final DSH answer'}],{id:'dsh'});
  await runProvider({provider,prompt:'x',workspace:f.directory,onEvent:event=>events.push(event)});
  const messages=events.filter(e=>e.type==='message');assert.equal(messages.length,1);
  assert.deepEqual(messages[0],{type:'message',role:'assistant',id:'dsh-final',text:'Final DSH answer',final:true,messageCapture:'final-only'});
  assert(events.some(e=>e.type==='text'&&e.text==='Streaming public text'));
});

test('a separate final result never replaces a preceding public assistant message',async t=>{
  const f=fixture(t),events=[],provider=f.events([
    {type:'assistant',message:{id:'before-final',content:[{type:'text',text:'I checked the project.'}]}},
    {type:'result',subtype:'success',is_error:false,result:'Final report.',usage:{}}
  ],{id:'claude'});
  await runProvider({provider,prompt:'x',workspace:f.directory,onEvent:event=>events.push(event)});
  assert.deepEqual(events.filter(e=>e.type==='message').map(e=>e.text),['I checked the project.','Final report.']);
});

test('model and prompt remain separate argv/stdin; no shell expansion is executed', async t => {
  const f = fixture(t);
  const marker = path.join(f.directory, 'injected-file');
  const prompt = `literal $(touch '${marker}'); \`touch '${marker}'\`\n"quoted"`;
  const model = 'a-model; touch malicious';
  const provider = f.script(`let input=''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', value => input += value);
    process.stdin.on('end', () => {
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:input}}));
      console.log(JSON.stringify({type:'turn.completed',usage:{}}));
    });`);
  const invocation = buildInvocation({ provider, stage: { id: 'plan', model, effort: 'high' }, prompt, workspace: f.directory });
  assert.equal(invocation.shell, false);
  assert.equal(invocation.stdin, prompt);
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], model);
  const result = await runProvider({ provider, prompt, stage: { model }, workspace: f.directory });
  assert.equal(result.text, prompt);
  assert.equal(fs.existsSync(marker), false);
});

test('rejects option-shaped model names, control characters, relative workspace and handoff execution', t => {
  const f = fixture(t);
  const provider = f.events([]);
  for (const model of ['--dangerous-option', 'abc\nxyz', 'a\0b']) {
    assert.throws(() => buildInvocation({ provider, stage: { model }, prompt: 'x', workspace: f.directory }), /模型名称无效/);
  }
  assert.throws(() => buildInvocation({ provider, prompt: 'x', workspace: './relative' }), /绝对路径/);
  assert.throws(() => buildInvocation({ provider: { id: 'marvis', mode: 'handoff' }, prompt: 'x', workspace: f.directory }), /手动交接/);
});

test('planning and acceptance are read-only; execution has workspace writes and disabled network', t => {
  const f = fixture(t);
  const provider = f.events([]);
  for (const role of ['plan', 'review', 'acceptance']) {
    const invocation = buildInvocation({ provider, stage: { role }, prompt: 'x', workspace: f.directory });
    assert.equal(invocation.args[invocation.args.indexOf('--sandbox') + 1], 'read-only');
    assert(invocation.args.includes('sandbox_workspace_write.network_access=false'));
    assert(!invocation.args.some(arg => arg.includes('bypass')));
  }
  const invocation = buildInvocation({ provider, stage: { id: 'execute' }, prompt: 'x', workspace: f.directory });
  assert.equal(invocation.args[invocation.args.indexOf('--sandbox') + 1], 'workspace-write');
});

test('only the selected provider receives its own explicitly allowed credential environment', t => {
  const f = fixture(t);
  const previous = { secret: process.env.UNRELATED_SECRET, claude: process.env.ANTHROPIC_API_KEY, node: process.env.NODE_OPTIONS };
  process.env.UNRELATED_SECRET = 'synthetic-private-value';
  process.env.ANTHROPIC_API_KEY = 'synthetic-provider-value';
  process.env.NODE_OPTIONS = '--synthetic-injected-flag';
  t.after(() => {
    for (const [key, value] of [['UNRELATED_SECRET', previous.secret], ['ANTHROPIC_API_KEY', previous.claude], ['NODE_OPTIONS', previous.node]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const codex = buildInvocation({ provider: f.events([]), prompt: 'x', workspace: f.directory });
  assert.equal(codex.env.UNRELATED_SECRET, undefined);
  assert.equal(codex.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(codex.env.NODE_OPTIONS, undefined);
  const claude = buildInvocation({ provider: f.events([], { id: 'claude' }), prompt: 'x', workspace: f.directory });
  assert.equal(claude.env.ANTHROPIC_API_KEY, 'synthetic-provider-value');
});

test('zero exit plus explicit WorkBuddy authentication error is a failure', async t => {
  const f = fixture(t);
  const provider = f.events([{ type: 'result', subtype: 'error_during_execution', is_error: true,
    errors: ['Authentication required. Please use /login command.'] }], { id: 'workbuddy' });
  await assert.rejects(runProvider({ provider, prompt: 'x', workspace: f.directory }), /Authentication required/);
});

test('a terminal success with a nonzero exit fails; text without a terminal success fails', async t => {
  const f = fixture(t);
  await assert.rejects(runProvider({ provider: f.events([complete({})], { exit: 2 }), prompt: 'x', workspace: f.directory }), /退出码 2/);
  await assert.rejects(runProvider({ provider: f.events([{ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }]),
    prompt: 'x', workspace: f.directory }), /成功终态/);
});

test('Codex uses the final aggregate once, preserves explicit zero caches and unknown cost', async t => {
  const f = fixture(t);
  const provider = f.events([{ type: 'thread.started', thread_id: 'synthetic-thread' },
    complete({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 }),
    complete({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 })]);
  const result = await runProvider({ provider, prompt: 'x', workspace: f.directory });
  assert.deepEqual(result.usage, { input: 10, output: 2, cacheRead: 0, cacheWrite: null, reasoning: null, costUSD: null });
  assert.equal(result.sessionId, 'synthetic-thread');
});

test('negative, boolean and nonfinite token values stay unknown', async t => {
  const f = fixture(t);
  const provider = f.events([complete({ input_tokens: -1, cached_input_tokens: false, output_tokens: '2' })]);
  const result = await runProvider({ provider, prompt: 'x', workspace: f.directory });
  assert.deepEqual(result.usage, { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, costUSD: null });
});

test('Anthropic full input includes cache creation/read; streamed usage is not added to final aggregate', async t => {
  const f = fixture(t);
  const provider = f.events([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }], usage: { input_tokens: 1000, output_tokens: 1000 } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.005,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
  ], { id: 'claude' });
  const result = await runProvider({ provider, prompt: 'x', workspace: f.directory });
  assert.deepEqual(result.usage, { input: 17, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: null, costUSD: 0.005 });
  assert.equal(result.text, 'done');
});

test('WorkBuddy formatter zero cost remains unknown and its complete input is not inflated by caches', async t => {
  const f = fixture(t);
  const provider = f.events([{ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }], { id: 'workbuddy' });
  const result = await runProvider({ provider, prompt: 'x', workspace: f.directory });
  assert.equal(result.usage.input, 10);
  assert.equal(result.usage.costUSD, null);
});

test('Anthropic omitted cache buckets do not become fabricated zeroes in complete input', async t => {
  const f = fixture(t);
  const provider = f.events([{ type: 'result', subtype: 'success', is_error: false, result: 'done',
    usage: { input_tokens: 10, output_tokens: 2 } }], { id: 'claude' });
  const result = await runProvider({ provider, prompt: 'x', workspace: f.directory });
  assert.equal(result.usage.input, null);
  assert.equal(result.usage.output, 2);
});

test('DSH requires completed turn_end and final plus zero exit', async t => {
  const f = fixture(t);
  const provider = f.events([{ type: 'final', text: 'plausible answer' }], { id: 'dsh' });
  await assert.rejects(runProvider({ provider, prompt: 'x', workspace: f.directory }), /成功终态/);
  const failed = f.events([{ type: 'status', phase: 'turn_end', reason: { kind: 'aborted' } }, { type: 'final', text: '' }], { id: 'dsh' });
  await assert.rejects(runProvider({ provider: failed, prompt: 'x', workspace: f.directory }), /轮次未成功/);
});

test('DSH sums distinct steps only once and keeps incomplete optional buckets unknown', async t => {
  const f = fixture(t);
  const step = (number, usage) => ({ type: 'status', phase: 'step_end', turn: 1, step: number, usage });
  const provider = f.events([
    step(1, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }),
    step(1, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }),
    step(2, { inputTokens: 20, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 8 }),
    dshEnd, { type: 'final', text: 'done' },
  ], { id: 'dsh' });
  const result = await runProvider({ provider, prompt: 'x', workspace: f.directory });
  assert.deepEqual(result.usage, { input: 30, output: 5, cacheRead: 5, cacheWrite: null, reasoning: null, costUSD: null });
});

test('an unreported DSH step prevents a partial sum from appearing complete', async t => {
  const f = fixture(t);
  const provider = f.events([
    { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'status', phase: 'step_end', turn: 1, step: 2 }, dshEnd, { type: 'final', text: 'done' },
  ], { id: 'dsh' });
  const result = await runProvider({ provider, prompt: 'x', workspace: f.directory });
  assert.equal(result.usage.input, null);
  assert.equal(result.usage.output, null);
});

test('DSH permissions are pinned by stage, ignoring ambient danger-full-access', t => {
  const f = fixture(t);
  const previous = process.env.DSH_PERMISSION_MODE;
  process.env.DSH_PERMISSION_MODE = 'danger-full-access';
  t.after(() => { if (previous === undefined) delete process.env.DSH_PERMISSION_MODE; else process.env.DSH_PERMISSION_MODE = previous; });
  const provider = f.events([], { id: 'dsh' });
  const read = buildInvocation({ provider, stage: { role: 'plan' }, prompt: 'x', workspace: f.directory });
  const write = buildInvocation({ provider, stage: { role: 'execute' }, prompt: 'x', workspace: f.directory });
  assert.equal(read.env.DSH_PERMISSION_MODE, 'read-only');
  assert.equal(write.env.DSH_PERMISSION_MODE, 'workspace-write');
});

test('DSH stable compound model IDs resolve the exact catalog route and reject made-up models or effort levels', t => {
  const f = fixture(t);
  const provider = { ...f.events([], { id: 'dsh' }), models: [
    { id: 'workbuddy-ai::model-a', modelId: 'model-a', providerRoute: 'workbuddy-ai', efforts: ['default', 'low', 'high'] },
    { id: 'workbuddy::model-a', modelId: 'model-a', providerRoute: 'workbuddy', efforts: ['default', 'max'] },
  ] };
  const invocation = buildInvocation({ provider, stage: { model: 'workbuddy-ai::model-a', effort: 'low', providerRoute: 'deepseek-official' },
    prompt: 'x', workspace: f.directory, patchPath: path.join(f.directory, 'patch.json') });
  assert.equal(invocation.selection.modelId, 'model-a');
  assert.equal(invocation.selection.providerRoute, 'workbuddy-ai');
  assert.equal(invocation.selection.profile, 'headless');
  assert.throws(() => buildInvocation({ provider, stage: { model: 'workbuddy-ai::missing' }, prompt: 'x', workspace: f.directory }), /当前已发现目录/);
  assert.throws(() => buildInvocation({ provider, stage: { model: 'workbuddy-ai::model-a', effort: 'max' }, prompt: 'x', workspace: f.directory }), /没有声明或验证/);
});

test('all saved DSH connector models remain discoverable with distinct routes and unverified-account metadata stays honest', t => {
  const f = fixture(t);
  const dshHome = path.join(f.directory, '.dsh');
  const connector = path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-workbuddy-connect');
  fs.mkdirSync(path.join(connector, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(connector, 'package.json'), JSON.stringify({ name: 'dsh-workbuddy-connect', version: '0.7.4', type: 'module' }));
  // This fixture never authenticates or contacts a model; empty variants trigger safe cache fallback.
  fs.writeFileSync(path.join(connector, 'lib', 'index.js'), 'export const WORKBUDDY_VARIANTS = [];');
  for (const [filename, models] of [
    ['.workbuddy-ai-catalog.json', [
      { id: 'same-model', name: 'Same', reasoning: { supportedEfforts: ['low', 'high'] }, apiKey: 'DO-NOT-EXPOSE' },
      { id: 'another-model', name: 'Another', reasoning: { supportedEfforts: ['max'] } },
    ]],
    ['.workbuddy-catalog.json', [{ id: 'same-model', name: 'Domestic Same', reasoning: { supportedEfforts: ['high'] } }]],
  ]) fs.writeFileSync(path.join(dshHome, filename), JSON.stringify({ version: 1,
    entries: { 'PRIVATE-ACCOUNT-KEY': { source: 'saved', fetchedAtMs: Date.now(), models } } }));
  const providers = detectProviders({ platform:'darwin', home: f.directory });
  const dsh = providers.find(provider => provider.id === 'dsh');
  const external = dsh.models.filter(model => ['workbuddy-ai', 'workbuddy'].includes(model.providerRoute));
  assert.equal(external.length, 3);
  assert(external.some(model => model.id === 'workbuddy-ai::same-model'));
  assert(external.some(model => model.id === 'workbuddy::same-model'));
  assert(external.every(model => model.ready === false && model.availability === 'unknown-account'));
  assert.deepEqual(external.find(model => model.id === 'workbuddy-ai::same-model').efforts, ['default', 'low', 'high']);
  const serialized = JSON.stringify(providers);
  assert(!serialized.includes('PRIVATE-ACCOUNT-KEY'));
  assert(!serialized.includes('DO-NOT-EXPOSE'));
});

test('DSH external routing loads the existing connector only in an owned home, preserves sessions and never copies credentials', async t => {
  const f = fixture(t);
  const dshHome = path.join(f.directory, 'original-dsh'); fs.mkdirSync(dshHome);
  fs.mkdirSync(path.join(dshHome, 'sessions'));
  fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'synthetic secret that must not be copied');
  fs.writeFileSync(path.join(dshHome, '.workbuddy-ai-catalog.json'), JSON.stringify({ version: 1, entries: {} }));
  const connectorEntry = path.join(f.directory, 'existing-connector.mjs'); fs.writeFileSync(connectorEntry, 'export function apply(){}');
  const capture = path.join(f.directory, 'route.json');
  const provider = { ...f.script(`process.stdin.resume();process.stdin.on('end',()=>{
    const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);const patchPath=args[args.indexOf('--patch')+1];
    const patches=JSON.parse(fs.readFileSync(patchPath,'utf8'));const config=patches.find(p=>p.id==='agent-default-model').config;
    const inserted=patches.filter(p=>p.insert).flatMap(p=>p.insert);const wrapper=inserted.find(p=>p.id==='agentflow-workbuddy');
    fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({home:process.env.DSH_HOME,mode:process.env.DSH_PERMISSION_MODE,
      config,wrapper:fs.readFileSync(wrapper.name,'utf8'),credentialsCopied:fs.existsSync(path.join(process.env.DSH_HOME,'.credentials.yaml')),
      sessions:fs.readlinkSync(path.join(process.env.DSH_HOME,'sessions'))}));
    console.log(JSON.stringify(${JSON.stringify(dshEnd)}));console.log(JSON.stringify({type:'final',text:'OK'}));
  });`, 'dsh'), models: [{ id: 'workbuddy-ai::hy3', modelId: 'hy3', providerRoute: 'workbuddy-ai', efforts: ['default', 'low'] }],
  connector: { entry: connectorEntry, dshHome, runtimeRoot: '/installed-runtime/dsh' } };
  const result = await runProvider({ provider, stage: { role: 'review', model: 'workbuddy-ai::hy3', effort: 'low', providerRoute: 'deepseek-official' },
    prompt: 'x', workspace: f.directory });
  const details = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(result.text, 'OK');
  assert.deepEqual(details.config, { provider: 'workbuddy-ai', model: 'hy3', reasoningEffort: 'low' });
  assert.equal(details.mode, 'read-only');
  assert.equal(details.credentialsCopied, false);
  assert.equal(fs.realpathSync(details.sessions), fs.realpathSync(path.join(dshHome, 'sessions')));
  assert(details.wrapper.includes('registerHooks'));
  assert(details.wrapper.includes(require('node:url').pathToFileURL(connectorEntry).href));
  assert(details.wrapper.includes('await ctx.llm.listModels("workbuddy-ai")'));
  assert(details.wrapper.includes('model.id==="hy3"'));
  assert.equal(fs.existsSync(details.home), false);
  assert.equal(fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8'), 'synthetic secret that must not be copied');
});

test('planning and acceptance on Claude or WorkBuddy expose only read tools and no external MCP', t => {
  const f = fixture(t);
  for (const id of ['claude', 'workbuddy']) {
    const invocation = buildInvocation({ provider: f.events([], { id }), stage: { role: 'review' }, prompt: 'x', workspace: f.directory });
    assert.equal(invocation.args[invocation.args.indexOf('--permission-mode') + 1], 'plan');
    assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert(invocation.args.includes('--strict-mcp-config'));
    assert.equal(invocation.args[invocation.args.indexOf('--setting-sources') + 1], id==='workbuddy'?'none':'');
  }
});

test('discovered app descriptors cannot override a known provider or turn an unverified executable into an agent', t => {
  const f = fixture(t);
  const providers = detectProviders({ platform:'darwin', home: f.directory, discoveredProviders: [
    { id: 'codex', name: 'override', executable: '/untrusted', ready: true },
    { id: 'app-example', name: 'Example', installed: true, appPath: '/Applications/Example.app', executable: '/untrusted', mode: 'cli', ready: true },
    { id: '../invalid', name: 'bad', installed: true },
  ] });
  assert.notEqual(providers.find(provider => provider.id === 'codex').name, 'override');
  assert(!providers.some(provider => provider.id === '../invalid'));
  const discovered = providers.find(provider => provider.id === 'app-example');
  assert.equal(discovered.mode, 'handoff');
  assert.equal(discovered.ready, false);
  assert.equal(discovered.executable, null);
});

test('OpenCode is a known entry and does not claim a configured model or unverified execution protocol', t => {
  const f = fixture(t);
  const opencode = detectProviders({ platform:'darwin', home: f.directory }).find(provider => provider.id === 'opencode');
  assert(opencode);
  assert.equal(opencode.mode, 'handoff');
  assert.equal(opencode.ready, false);
  assert.deepEqual(opencode.efforts, ['default']);
  assert.equal(opencode.models[0].ready, false);
});

test('a line over 1 MiB fails and bounds the subprocess', async t => {
  const f = fixture(t);
  const provider = f.events([], { suffix: 'process.stdout.write("x".repeat(1024 * 1024 + 1));' });
  await assert.rejects(runProvider({ provider, prompt: 'x', workspace: f.directory }), /1 MiB/);
});

test('total stdout/stderr over 16 MiB fails even when every event line is below its own bound', async t => {
  const f = fixture(t);
  const provider = f.events([], { suffix: 'for(let i=0;i<70;i++)process.stdout.write("x".repeat(256*1024)+"\\n");' });
  await assert.rejects(runProvider({ provider, prompt: 'x', workspace: f.directory }), /16 MiB/);
});

test('connection probes disable WorkBuddy/Claude tools, MCP and hooks, and replace arbitrary prompt', t => {
  const f = fixture(t);
  for (const id of ['workbuddy', 'claude']) {
    const provider = f.events([], { id });
    const invocation = buildInvocation({ provider, stage: { probe: true }, prompt: 'untrusted task', workspace: f.directory });
    assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], '');
    assert.equal(invocation.args[invocation.args.indexOf('--permission-mode') + 1], 'plan');
    assert(invocation.args.includes('--strict-mcp-config'));
    assert.equal(invocation.args[invocation.args.indexOf('--setting-sources') + 1], id==='workbuddy'?'none':'');
    assert(!invocation.stdin.includes('untrusted task'));
  }
});

test('probeProvider owns and removes only its new directory; it rejects non-OK success', async t => {
  const f = fixture(t);
  const keep = path.join(f.directory, 'keep'); fs.writeFileSync(keep, 'preserve');
  const capture = path.join(f.directory, 'probe-path');
  const provider = f.script(`process.stdin.resume();process.stdin.on('end',()=>{
    require('node:fs').writeFileSync(${JSON.stringify(capture)},process.cwd());
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK',usage:{}}));
  });`, 'workbuddy');
  const result = await probeProvider({ provider, workspace: f.directory });
  assert.equal(result.text, 'OK');
  assert.equal(result.verifiedModelId, 'default');
  assert.equal(result.verifiedRequestModelId, 'fast-model');
  const probePath = fs.readFileSync(capture, 'utf8');
  assert.notEqual(probePath, f.directory);
  assert.equal(fs.existsSync(probePath), false);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'preserve');
  const bad = f.events([{ type: 'result', subtype: 'success', is_error: false, result: 'something else', usage: {} }], { id: 'workbuddy' });
  await assert.rejects(probeProvider({ provider: bad }), /约定的 OK/);
  const tool = f.events([{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: {} }], { id: 'workbuddy' });
  await assert.rejects(probeProvider({ provider: tool }), /工具调用事件/);
});

test('DSH probe installs both schema restriction and an execution guard in a private temporary patch', async t => {
  const f = fixture(t);
  const capture = path.join(f.directory, 'probe-details');
  const provider = f.script(`let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{
    const fs=require('node:fs');const args=process.argv.slice(2);const patchPath=args[args.indexOf('--patch')+1];
    const patches=JSON.parse(fs.readFileSync(patchPath,'utf8'));const guardPath=patches.find(p=>p.insert)?.insert[0].name;
    fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({patchPath,guard:fs.readFileSync(guardPath,'utf8'),mode:process.env.DSH_PERMISSION_MODE,input}));
    console.log(JSON.stringify(${JSON.stringify(dshEnd)}));console.log(JSON.stringify({type:'final',text:'OK'}));
  });`, 'dsh');
  await probeProvider({ provider });
  const details = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(details.mode, 'read-only');
  assert(details.guard.includes('ctx.tools.guard('));
  assert(details.guard.includes('restrict({ allow: [] })'));
  assert.equal(fs.existsSync(details.patchPath), false);
});

test('cancelling terminates the process group including an independently running descendant', { skip: process.platform === 'win32', timeout: 12000 }, async t => {
  const f = fixture(t);
  const capture = path.join(f.directory, 'child.pid');
  const provider = f.script(`process.stdin.resume();process.stdin.on('end',()=>{
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    require('node:fs').writeFileSync(${JSON.stringify(capture)},String(child.pid));
    console.log(JSON.stringify({type:'thread.started',thread_id:'ready-to-cancel'}));setInterval(()=>{},1000);
  });`);
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const failSafe = setTimeout(() => controller.abort(), 5000);
  let executionError;
  const execution = runProvider({ provider, prompt: 'x', workspace: f.directory, signal: controller.signal,
    onEvent: event => { if (event.type === 'session') started(); } }).catch(error => { executionError = error; });
  try {
    await Promise.race([ready, execution]);
    assert.equal(executionError, undefined, executionError?.message);
    const descendantPID = Number(fs.readFileSync(capture, 'utf8'));
    controller.abort(); await execution;
    assert.match(executionError.message, /已取消/);
    let alive = true;
    for (let i = 0; i < 40; i++) {
      try { process.kill(descendantPID, 0); } catch { alive = false; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, 'descendant process must not survive cancellation');
  } finally { clearTimeout(failSafe); controller.abort(); await execution; }
});


test('Claude logged-in detection synchronizes the default model while unknown model efforts stay conservative', t => {
  const f=fixture(t),directory=path.join(f.directory,'.local','bin');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'claude'),`#!${process.execPath}\nif(process.argv.includes('--help'))console.log('--print --output-format --effort');else if(process.argv.includes('status'))console.log(JSON.stringify({loggedIn:true}));else process.exitCode=77;\n`,{mode:0o700});
  const claude=detectProviders({ platform:'darwin', home:f.directory}).find(p=>p.id==='claude');
  assert.equal(claude.ready,true);assert.equal(claude.models[0].ready,true);
  assert.equal(claude.models[0].availability,'configured');assert.deepEqual(claude.models[0].efforts,['default']);
  assert.throws(()=>buildInvocation({provider:claude,stage:{model:'default',effort:'max'},prompt:'x',workspace:f.directory}),/思考强度/);
});

test('probe verification promotes only the exact model on the same executable and expires without mutating the catalog',()=>{
  const provider={id:'workbuddy',mode:'cli',ready:false,executable:'/exact/cli',models:[
    {id:'default',modelId:'fast-model',efforts:['default'],ready:false,availability:'needs-cli-authentication'},
    {id:'unprobed',efforts:['default','high'],ready:false,availability:'needs-cli-authentication'}]};
  const now=Date.now(),proof={executable:provider.executable,at:now,modelId:'default'};
  const ready=applyProviderVerification(provider,proof,now);
  assert.equal(ready.ready,true);assert.equal(ready.models[0].ready,true);assert.equal(ready.models[0].availability,'verified');
  assert.equal(ready.models[1].ready,false);assert.equal(provider.models[0].ready,false);
  const invocation=buildInvocation({provider:ready,stage:{model:''},prompt:'x',workspace:os.tmpdir()});
  assert.equal(invocation.args[invocation.args.indexOf('--model')+1],'fast-model');
  for(const invalid of [{...proof,executable:'/another/cli'},{...proof,at:now-3600000},{...proof,at:now+1},{...proof,modelId:'unknown'}]){
    assert.equal(applyProviderVerification(provider,invalid,now),provider);
  }
  assert.equal(applyProviderVerification({...provider,mode:'handoff'},proof,now).ready,false);
});

test('Codex recoverable diagnostics retain the clean message and do not override an explicit successful turn',async t=>{
  const f=fixture(t),events=[];
  const provider=f.events([{type:'item.completed',item:{type:'error',message:'Optional plugin unavailable, api_key=synthetic-secret'}},
    {type:'error',message:'Reconnecting 1/5'},
    {type:'item.completed',item:{type:'agent_message',text:'done'}},complete({input_tokens:3,output_tokens:1})]);
  const result=await runProvider({provider,prompt:'x',workspace:f.directory,onEvent:event=>events.push(event)});
  assert.equal(result.text,'done');
  const diagnostics=events.filter(event=>event.activity==='diagnostic');assert.equal(diagnostics.length,2);
  assert(diagnostics.every(event=>event.level==='warning'));assert.match(diagnostics[0].message,/Optional plugin unavailable/);
  assert(!JSON.stringify(diagnostics).includes('synthetic-secret'));
  const noTerminal=f.events([{type:'error',message:'Disconnected without a successful turn'}]);
  await assert.rejects(runProvider({provider:noTerminal,prompt:'x',workspace:f.directory}),/Disconnected/);
  const failed=f.events([{type:'turn.failed',error:{message:'Actual terminal failure'}},complete({})]);
  await assert.rejects(runProvider({provider:failed,prompt:'x',workspace:f.directory}),/Actual terminal failure/);
});


test('Electron ASAR directory semantics still run the connector metadata check using an isolated synthetic account', {
  skip:process.platform!=='darwin'||!fs.existsSync('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'),timeout:20000
}, t=>{
  const f=fixture(t),electron=[path.join(__dirname,'../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),'/Applications/AgentFlow.app/Contents/MacOS/AgentFlow'].find(p=>fs.existsSync(p));
  if(!electron){t.skip('No Electron runtime installed');return;}
  const connector=path.join(f.directory,'.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect');fs.mkdirSync(path.join(connector,'lib'),{recursive:true});
  fs.writeFileSync(path.join(connector,'package.json'),JSON.stringify({name:'dsh-workbuddy-connect',version:'0.0.0-fixture',type:'module'}));
  fs.writeFileSync(path.join(connector,'lib/index.js'),`export const WORKBUDDY_VARIANTS=[{id:'workbuddy-ai',displayName:'Fixture',region:'global',catalogFilename:'fixture',probeFilename:'fixture'}];
    export class WorkBuddyUpstreamClient{};
    export class WorkBuddyCredentialStore{async current(){return {synthetic:true};}};
    export const visibilityAccountOf=()=> 'fixture-account';
    export const workbuddyCatalogPath=()=> 'unused-fixture-path';
    export const workbuddyProbePath=()=> 'unused-fixture-path';
    export class WorkBuddyCatalogStore{get(){return {fetchedAtMs:1,models:[{id:'fixture-model',name:'Fixture Model',reasoning:{supports:true,supportedEfforts:['low']}}]};}};
    export class WorkBuddyProbeStore{get(){return undefined;}};
    export const fingerprintModel=()=> 'fixture';`);
  const source=path.resolve(__dirname,'../lib/providers.cjs');
  const script=`const fs=require('node:fs');const {detectProviders}=require(${JSON.stringify(source)});const stats=fs.statSync('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar');const dsh=detectProviders({ platform:'darwin', home:${JSON.stringify(f.directory)}}).find(p=>p.id==='dsh');const model=dsh.models.find(m=>m.id==='workbuddy-ai::fixture-model');console.log(JSON.stringify({asarFile:stats.isFile(),asarDirectory:stats.isDirectory(),ready:dsh.ready,model:model&&{id:model.id,ready:model.ready,availability:model.availability,efforts:model.efforts}}));`;
  const output=execFileSync(electron,['-e',script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
  const got=JSON.parse(output.trim());assert.equal(got.asarFile,false);assert.equal(got.asarDirectory,true);
  assert.equal(got.ready,true);assert.deepEqual(got.model,{id:'workbuddy-ai::fixture-model',ready:true,availability:'configured-cached',efforts:['default','low']});
});


test('desktop login or connector credential changes invalidate cached model readiness immediately',{
 skip:process.platform!=='darwin'||!fs.existsSync('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'),timeout:15000
},t=>{
 const f=fixture(t),connector=path.join(f.directory,'.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect');fs.mkdirSync(path.join(connector,'lib'),{recursive:true});
 fs.writeFileSync(path.join(connector,'package.json'),JSON.stringify({name:'dsh-workbuddy-connect',version:'0.0.0-fixture',type:'module'}));
 fs.writeFileSync(path.join(connector,'lib/index.js'),`import fs from 'node:fs';import path from 'node:path';
 export const WORKBUDDY_VARIANTS=[{id:'workbuddy-ai',displayName:'Fixture',region:'global',catalogFilename:'fixture',probeFilename:'fixture'}];
 export class WorkBuddyUpstreamClient{};export class WorkBuddyCredentialStore{async current(){return fs.existsSync(path.join(process.env.HOME,'.dsh','.workbuddy-ai-auth.json'))?{synthetic:true}:undefined;}};
 export const visibilityAccountOf=()=> 'fixture-account';export const workbuddyCatalogPath=()=> 'unused';export const workbuddyProbePath=()=> 'unused';
 export class WorkBuddyCatalogStore{get(){return {fetchedAtMs:1,models:[{id:'fixture-model',name:'Fixture'}]};}};
 export class WorkBuddyProbeStore{get(){return undefined;}};export const fingerprintModel=()=> 'fixture';`);
 const before=detectProviders({ platform:'darwin', home:f.directory}).find(p=>p.id==='workbuddy');assert.equal(before.ready,false);
 const auth=path.join(f.directory,'.dsh/.workbuddy-ai-auth.json');fs.writeFileSync(auth,'{}');
 const after=detectProviders({ platform:'darwin', home:f.directory}).find(p=>p.id==='workbuddy');assert.equal(after.ready,true);
 assert.equal(after.models.find(m=>m.id==='fixture-model').ready,true);
 fs.rmSync(auth);
 const signedOut=detectProviders({ platform:'darwin', home:f.directory}).find(p=>p.id==='workbuddy');assert.equal(signedOut.ready,false);
});


function codeBuddyFixture(t, source) {
  const f=fixture(t),directory=path.join(f.directory,'runtime/node_modules/@tencent-ai/codebuddy-code');
  fs.mkdirSync(path.join(directory,'bin'),{recursive:true});
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'@tencent-ai/codebuddy-code',version:'2.167.0',bin:{codebuddy:'./bin/codebuddy'}}));
  const executable=path.join(directory,'bin/codebuddy');
  fs.writeFileSync(executable,`#!${process.execPath}\n${source||''}\n`,{mode:0o700});
  return {...f,executable,packageDirectory:directory};
}

test('CodeBuddy CLI detection requires the exact official package and keeps unverified models unavailable',t=>{
  const f=codeBuddyFixture(t);
  const get=()=>detectProviders({ platform:'darwin', home:f.directory,codebuddyCLIPath:f.executable}).find(p=>p.id==='codebuddy');
  const provider=get();assert.equal(provider.mode,'cli');assert.equal(provider.executable,fs.realpathSync(f.executable));
  assert.equal(provider.ready,false);assert.equal(provider.models.length,1);assert.equal(provider.models[0].id,'default');
  assert.equal(provider.models[0].ready,false);assert.equal(provider.officialPackage.name,'@tencent-ai/codebuddy-code');
  fs.writeFileSync(path.join(f.packageDirectory,'package.json'),JSON.stringify({name:'unrelated-package',version:'2.167.0',bin:{codebuddy:'./bin/codebuddy'}}));
  assert.equal(get().mode,'handoff');assert.equal(get().ready,false);
});

test('CodeBuddy strips foreign credentials and endpoints while enforcing tools, MCP and setting isolation for read-only and probes',t=>{
  const f=codeBuddyFixture(t),provider=detectProviders({ platform:'darwin', home:f.directory,codebuddyCLIPath:f.executable}).find(p=>p.id==='codebuddy');
  const keys=['OPENAI_API_KEY','ANTHROPIC_API_KEY','CODEBUDDY_API_KEY','CODEBUDDY_AUTH_TOKEN','CODEBUDDY_BASE_URL','CODEBUDDY_INTERNET_ENVIRONMENT','ACC_PRODUCT_CONFIG_V3','NODE_OPTIONS'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});
  for(const key of keys)process.env[key]='SYNTHETIC_FOREIGN_VALUE';
  for(const stage of [{role:'plan'},{role:'review'},{role:'execute'},{probe:true}]){
    const invocation=buildInvocation({provider,stage,prompt:'x',workspace:f.directory,nodePath:process.execPath});
    assert.equal(invocation.command,process.execPath);assert.equal(invocation.args[0],fs.realpathSync(f.executable));
    assert.equal(invocation.args[invocation.args.indexOf('--setting-sources')+1],'none');
    assert.equal(invocation.env.DISABLE_AUTOUPDATER,'1');
    assert.equal(invocation.env.CODEBUDDY_DISABLE_PRODUCT_CACHE,'1');
    assert(!JSON.stringify(invocation.env).includes('SYNTHETIC_FOREIGN_VALUE'));
    if(stage.role!=='execute'){
      assert.equal(invocation.args[invocation.args.indexOf('--permission-mode')+1],'plan');
      assert.equal(invocation.args[invocation.args.indexOf('--tools')+1],stage.probe?'':'Read,Glob,Grep');
      assert(invocation.args.includes('--strict-mcp-config'));
    }
  }
});

test('CodeBuddy account and catalog enrichment is explicit, exact, temporary and separate from execution verification',async t=>{
  const f=codeBuddyFixture(t),provider=detectProviders({ platform:'darwin', home:f.directory,codebuddyCLIPath:f.executable}).find(p=>p.id==='codebuddy');
  let temporary;
  const configured=await enrichCodeBuddyProvider(provider,{refresh:true,inspect:async options=>{temporary=options.cwd;assert(fs.existsSync(temporary));return {
    authenticated:true,executionVerified:false,defaultModelId:'exact-model',models:[{id:'exact-model',label:'Exact',efforts:['default','low','high','off','ultra']},{id:'other-model',label:'Other',efforts:['default']}]
  };}});
  assert.equal(configured.ready,true);assert.equal(configured.models.length,3);assert.equal(configured.authenticationState,'configured');
  assert.equal(fs.existsSync(temporary),false);
  assert.equal(configured.models.find(m=>m.id==='default').modelId,'exact-model');
  assert.deepEqual(configured.models.find(m=>m.id==='default').efforts,['default','low','high']);
  assert.equal(configured.models.find(m=>m.id==='exact-model').availability,'configured-cli-account');
  assert.throws(()=>buildInvocation({provider:configured,stage:{model:'other-model',effort:'max'},prompt:'x',workspace:f.directory}),/思考强度/);
  assert.throws(()=>buildInvocation({provider:configured,stage:{model:'invented-model'},prompt:'x',workspace:f.directory}),/目录确认/);
  const unauthenticated=await enrichCodeBuddyProvider(provider,{refresh:true,inspect:async()=>({authenticated:false,models:[]})});
  assert.equal(unauthenticated.ready,false);assert(unauthenticated.models.every(m=>m.ready===false));
  assert.equal(applyProviderVerification(unauthenticated,{modelId:'default',executable:f.executable,at:Date.now()}).ready,false);
  const unknown=await enrichCodeBuddyProvider(provider,{refresh:true,inspect:async()=>{throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC');}});
  assert.equal(unknown.ready,false);assert(!JSON.stringify(unknown).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
});

test('connection probes choose only a declared cheaper effort; explicit choices and task defaults remain intact',async t=>{
  const f=fixture(t);let serial=0;
  async function runCase({id='codebuddy',models,stage={},expectedModel='default',expectedEffort='default'}){
    const capture=path.join(f.directory,`probe-effort-${serial++}.json`);
    const provider={...f.script(`process.stdin.resume();process.stdin.on('end',()=>{
      require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));
      ${id==='dsh'?`console.log(JSON.stringify(${JSON.stringify(dshEnd)}));console.log(JSON.stringify({type:'final',text:'OK'}));`:`console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK',usage:{}}));`}
    });`,id),models};
    const result=await probeProvider({provider,stage,nodePath:process.execPath});
    const args=JSON.parse(fs.readFileSync(capture,'utf8')),index=args.indexOf('--effort');
    if(id!=='dsh')assert.equal(index===-1?'default':args[index+1],expectedEffort);
    assert.equal(result.verifiedEffort,expectedEffort);assert.equal(result.verifiedModelId,expectedModel);
    if(id!=='dsh'){
      const normal=buildInvocation({provider,stage:{model:expectedModel,effort:'default'},prompt:'Normal task',workspace:f.directory,nodePath:process.execPath});
      assert.equal(normal.args.includes('--effort'),false,'normal task default must keep the vendor default');
    }
    return args;
  }
  await runCase({models:[{id:'default',ready:true,efforts:['default','low','high']}],expectedEffort:'low'});
  await runCase({models:[{id:'default',ready:true,efforts:['default','high']}]});
  await runCase({models:[{id:'default',ready:true}],expectedEffort:'default'});
  await runCase({id:'dsh',models:[{id:'default',ready:true,efforts:['default','off','low']}],expectedEffort:'off'});
  await runCase({id:'dsh',models:[{id:'default',ready:true,efforts:['default','none','low']}],expectedEffort:'none'});
  await runCase({models:[{id:'default',ready:true,efforts:['default','low','high']}],stage:{effort:'high'},expectedEffort:'high'});
  await runCase({models:[{id:'default',ready:true,efforts:['default','low','high']}],stage:{effort:'default'}});
  const models=[{id:'default',modelId:'expensive',ready:true,efforts:['default','high']},
    {id:'unverified-low',ready:false,efforts:['default','low']},{id:'cheap',modelId:'cheap-actual',ready:true,efforts:['default','low','high']}];
  const args=await runCase({models,expectedModel:'cheap',expectedEffort:'low'});
  assert.equal(args[args.indexOf('--model')+1],'cheap-actual');
  await runCase({models,stage:{model:'default'},expectedEffort:'default'});
  await runCase({models,stage:{model:'cheap',effort:'high'},expectedModel:'cheap',expectedEffort:'high'});
});

test('CodeBuddy stream-json uses strict terminal results, usage, actual model and disabled-tool probes',async t=>{
  const f=codeBuddyFixture(t,`process.stdin.resume();process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:'synthetic-cb-session',model:'actual-cb-model'}));
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK',total_cost_usd:0,usage:{input_tokens:5,output_tokens:1,cache_read_input_tokens:0}}));
  });`);
  const provider=detectProviders({ platform:'darwin', home:f.directory,codebuddyCLIPath:f.executable}).find(p=>p.id==='codebuddy');
  const result=await probeProvider({provider,nodePath:process.execPath});
  assert.equal(result.text,'OK');assert.equal(result.verifiedModelId,'default');assert.equal(result.verifiedRequestModelId,'actual-cb-model');
  assert.equal(result.origin,'codebuddy-official-cli');assert.equal(result.usage.input,5);assert.equal(result.usage.cacheRead,0);assert.equal(result.usage.costUSD,null);
  const failed=f.events([{type:'result',subtype:'error_during_execution',is_error:true,errors:['AUTH_REQUIRED']}],{id:'codebuddy'});
  await assert.rejects(runProvider({provider:failed,prompt:'x',workspace:f.directory,nodePath:process.execPath}),/AUTH_REQUIRED/);
});

test('Google Gemini adapter records public streaming text, exact model, usage and strict completion',async t=>{
  const f=fixture(t),directory=path.join(f.directory,'gemini-package');fs.mkdirSync(directory);
  const executable=path.join(directory,'index.js');fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'@google/gemini-cli',version:'1.0.0',bin:{gemini:'index.js'}}));
  fs.writeFileSync(executable,`process.stdin.resume();process.stdin.on('end',()=>{for(const row of ${JSON.stringify([
    {type:'init',session_id:'google-session',model:'gemini-model'},
    {type:'message',role:'assistant',content:'Hello ',delta:true},
    {type:'message',role:'assistant',content:'world',delta:true},
    {type:'result',status:'success',stats:{input_tokens:11,output_tokens:2,cached:4}}
  ])})console.log(JSON.stringify(row));});`);
  const provider={id:'gemini',mode:'cli',ready:true,executable,models:[{id:'default',ready:true,efforts:['default']}],capabilities:{readOnly:true}};
  const events=[];const result=await runProvider({provider,stage:{role:'acceptance'},prompt:'test',workspace:f.directory,onEvent:e=>events.push(e)});
  assert.equal(result.text,'Hello world');assert.equal(result.sessionId,'google-session');assert.equal(result.modelId,'gemini-model');assert.equal(result.usage.input,11);assert.equal(result.usage.cacheRead,4);
  assert.equal(events.filter(e=>e.type==='message').at(-1).text,'Hello world');
  const invocation=buildInvocation({provider,stage:{role:'acceptance'},prompt:'never shell $(echo x)',workspace:f.directory});
  assert.equal(invocation.args[invocation.args.indexOf('--approval-mode')+1],'plan');assert.equal(invocation.stdin,'never shell $(echo x)');assert.equal(invocation.shell,false);
  fs.writeFileSync(executable,`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',status:'error',error:{message:'denied'}})));`);
  await assert.rejects(runProvider({provider,prompt:'test',workspace:f.directory}),/denied/);
  await assert.rejects(probeProvider({provider}),/没有已验证/);
});

test('Gemini existing configuration can be verified in an isolated tool-disabled workspace and enables only observed models',async t=>{
  const f=fixture(t),directory=path.join(f.directory,'gemini-probe-package');fs.mkdirSync(directory);
  const executable=path.join(directory,'index.js'),capture=path.join(f.directory,'probe-cwd.txt');
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'@google/gemini-cli',version:'0.64.0',bin:{gemini:'index.js'}}));
  fs.writeFileSync(executable,`const fs=require('node:fs');let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(capture)},process.cwd());const settings=JSON.parse(fs.readFileSync('.gemini/settings.json'));if(prompt!=='Reply exactly OK. Do not use any tools.'||settings.hooksConfig.enabled!==false||settings.admin.mcp.enabled!==false||!process.argv.includes('--admin-policy'))process.exit(2);console.log(JSON.stringify({type:'init',session_id:'verified-google',model:'gemini-observed'}));console.log(JSON.stringify({type:'message',role:'assistant',content:'OK',delta:true}));console.log(JSON.stringify({type:'result',status:'success',stats:{input_tokens:2,output_tokens:1}}));});`);
  const provider={id:'gemini',mode:'cli',ready:false,version:'0.64.0',executable,authStatus:'configured',models:[{id:'default',ready:false,efforts:['default']}],capabilities:{readOnly:true,probe:true}};
  const result=await probeProvider({provider});assert.equal(result.text,'OK');assert.equal(result.modelId,'gemini-observed');assert.equal(result.verifiedModelId,'default');
  const probeWorkspace=fs.readFileSync(capture,'utf8');assert.notEqual(probeWorkspace,f.directory);assert.equal(fs.existsSync(probeWorkspace),false);
  const next=applyProviderVerification(provider,{executable,at:Date.now(),modelId:'default',actualModelId:result.modelId,providerVersion:provider.version});
  assert.equal(applyProviderVerification({...provider,version:'0.65.0'},{executable,at:Date.now(),modelId:'default',providerVersion:'0.64.0'}).ready,false);
  assert.equal(next.ready,true);assert.deepEqual(next.models.map(m=>[m.id,m.ready]),[['default',true],['gemini-observed',true]]);
  assert.throws(()=>buildInvocation({provider:next,stage:{model:'invented-model'},prompt:'x',workspace:f.directory}),/所选模型/);
});

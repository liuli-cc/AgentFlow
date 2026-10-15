'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { ApiRegistry } = require('../lib/api-providers.cjs');

function fixture(t, fetchImpl, extras = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-api-test-'));
  const dataDir = path.join(directory, 'data');
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const key = randomBytes(32);
  const vault = { isAvailable: () => true, encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decrypt(buffer) { const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); decipher.setAuthTag(buffer.subarray(-16)); return Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]).toString('utf8'); } };
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const requests = [];
  const registry = new ApiRegistry({ dataDir, vault, fetchImpl: async (url, init) => { requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); return fetchImpl(url, init, requests.length); }, ...extras });
  return { directory, dataDir, workspace, vault, requests, registry };
}
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const chat = (text = 'done', usage = { prompt_tokens: 10, completion_tokens: 4 }, calls) => ({ id: 'chat-session', choices: [{ message: { role: 'assistant', content: text, ...(calls ? { tool_calls: calls } : {}) } }], usage });
const call = (name, args, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function save(f, extra = {}) { await f.registry.init(); return f.registry.saveProvider({ name: 'My API', baseUrl: 'https://example.test/v1', protocol: 'openai', apiKey: 'synthetic-secret-012345', models: [{ id: 'custom-model', efforts: ['low', 'high'] }], ...extra }); }

test('secrets are encrypted on disk, absent from public metadata, and empty updates retain them', async t => {
  const f = fixture(t, () => reply({ data: [{ id: 'custom-model' }] }));
  let provider = await save(f);
  assert.equal(provider.ready, false);
  assert.match(provider.id, /^api-[a-f0-9-]{36}$/);
  const disk = fs.readFileSync(path.join(f.dataDir, 'api-providers.json'), 'utf8');
  assert(!disk.includes('synthetic-secret-012345'));
  const ciphertext = JSON.parse(disk).providers[0].ciphertext;
  assert(!JSON.stringify(f.registry.getProviders()).includes(ciphertext));
  assert(!JSON.stringify(provider).includes('synthetic-secret'));
  if(process.platform!=='win32')assert.equal(fs.statSync(path.join(f.dataDir, 'api-providers.json')).mode & 0o777, 0o600);
  provider = await f.registry.saveProvider({ id: provider.id, name: 'Renamed', apiKey: '' });
  assert.equal(provider.hasKey, true);
  provider = await f.registry.refreshModels(provider.id);
  assert.equal(provider.ready, true);
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer synthetic-secret-012345');
  provider = await f.registry.saveProvider({ id: provider.id, clearKey: true });
  assert.equal(provider.hasKey, false);
  assert.equal(provider.ready, false);
});

test('vault failure refuses credential persistence; settings and readiness survive reload', async t => {
  const f = fixture(t, () => reply({ data: [{ id: 'custom-model' }] }));
  const provider = await save(f);
  await f.registry.refreshModels(provider.id);
  const reloaded = new ApiRegistry({ dataDir: f.dataDir, vault: f.vault });
  await reloaded.init();
  assert.equal(reloaded.getProviders()[0].ready, true);
  const unavailable = new ApiRegistry({ dataDir: path.join(f.directory, 'unavailable'), vault: { isAvailable: () => false } });
  await unavailable.init();
  await assert.rejects(unavailable.saveProvider({ name: 'x', baseUrl: 'https://x.test/v1', protocol: 'openai', apiKey: 'secret' }), /安全存储/);
  assert.equal(unavailable.getProviders().length, 0);
});

test('rejects dangerous endpoint forms and sends only to the exact configured origin', async t => {
  const f = fixture(t, () => reply({ data: [{ id: 'custom-model' }] }));
  await f.registry.init();
  for (const baseUrl of ['http://example.test/v1', 'file:///tmp/x', 'https://user:pw@example.test', 'https://example.test?a=1', 'https://example.test#fragment', 'https://example.test\\@evil.test', 'https://example.test\n']) {
    await assert.rejects(f.registry.saveProvider({ name: 'x', baseUrl, protocol: 'openai' }), /地址/);
  }
  const local = await f.registry.saveProvider({ name: 'local', baseUrl: 'http://127.0.0.1:1234/v1', protocol: 'openai' });
  await f.registry.refreshModels(local.id);
  assert.equal(f.requests[0].url, 'http://127.0.0.1:1234/v1/models');
  assert.equal(f.requests[0].init.redirect, 'error');
  assert.equal(f.requests[0].init.headers.Authorization, undefined);
});

test('redirects and remote error bodies cannot reveal credentials', async t => {
  const f = fixture(t, (_url, _init, count) => count === 1 ? reply({ error: { message: 'synthetic-secret-012345' } }, 401) : new Response('', { status: 302, headers: { Location: 'https://other.test' } }));
  const provider = await save(f);
  await assert.rejects(f.registry.refreshModels(provider.id), error => !error.message.includes('synthetic-secret') && /401/.test(error.message));
  await assert.rejects(f.registry.refreshModels(provider.id), /重定向/);
  assert.equal(f.registry.getProviders()[0].ready, false);
  assert(!JSON.stringify(f.registry.getProviders()).includes('synthetic-secret'));
});

test('unsupported /models preserves manual choices; explicit probe has no tools and validates readiness', async t => {
  const f = fixture(t, (_url, _init, count) => count === 1 ? reply({}, 404) : reply(chat('OK')));
  const provider = await save(f);
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.registry.refreshModels(provider.id), /404/);
  assert.equal(f.registry.getProviders()[0].models[0].id, 'custom-model');
  assert.equal(f.registry.getProviders()[0].ready, false);
  const probed = await f.registry.probeProvider(provider.id, 'custom-model');
  assert.equal(probed.ready, true);
  assert.equal(probed.models[0].source, 'probe');
  assert.equal(f.requests[1].body.tools, undefined);
  assert(f.requests[1].body.max_completion_tokens <= 64);
  await f.registry.removeProvider(provider.id);
  assert.deepEqual(f.registry.getProviders(), []);
});

test('OpenAI chat executes bounded workspace tools and accumulates total/cache/reasoning separately', async t => {
  const firstUsage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } };
  const f = fixture(t, (_url, _init, count) => count === 1 ? reply(chat('Starting. ', firstUsage, [call('write_file', { path: 'nested/result.txt', content: 'hello' })])) : reply(chat('Complete.', { prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 3 } })));
  const provider = await save(f);
  const events = [];
  const result = await f.registry.runProvider({ provider, stage: { role: 'execute', model: 'custom-model', effort: 'high' }, prompt: 'Create a file', workspace: f.workspace, onEvent: event => events.push(event) });
  assert.equal(fs.readFileSync(path.join(f.workspace, 'nested/result.txt'), 'utf8'), 'hello');
  assert.equal(result.text, 'Starting. Complete.');
  assert.deepEqual(result.usage, { input: 150, output: 30, cacheRead: 50, cacheWrite: null, reasoning: 8, costUSD: null, source: 'api' });
  assert.equal(f.requests[0].body.reasoning_effort, 'high');
  assert.equal(f.requests[1].body.messages[2].role, 'tool');
  assert.equal(events.filter(event=>event.type==='text').at(-1).replace, true);
  assert.deepEqual(events.filter(event=>event.type==='message').map(({id,role,text})=>({id,role,text})),[
    {id:'api-round-1',role:'assistant',text:'Starting. '},{id:'api-round-2',role:'assistant',text:'Complete.'}]);
  assert.equal(events.filter(event => event.type === 'usage').length, 2);
});

test('Responses passes reasoning state and function outputs back with the correct schema', async t => {
  const reasoning = { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque-data', summary: [] };
  const f = fixture(t, (_url, _init, count) => reply(count === 1 ? { id: 'resp-1', output: [reasoning, { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"input.txt"}' }], usage: { input_tokens: 30, output_tokens: 8, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 4 } } } : { id: 'resp-2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Read it.' }] }], usage: { input_tokens: 20, output_tokens: 6, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 } } }));
  fs.writeFileSync(path.join(f.workspace, 'input.txt'), 'sample');
  const provider = await save(f, { protocol: 'responses' });
  const result = await f.registry.runProvider({ provider, stage: { role: 'plan', effort: 'low' }, prompt: 'Read', workspace: f.workspace });
  assert.equal(f.requests[0].url, 'https://example.test/v1/responses');
  assert.equal(f.requests[0].body.store, false);
  assert.deepEqual(f.requests[0].body.reasoning, { effort: 'low' });
  assert.deepEqual(f.requests[0].body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(f.requests[1].body.input[1], reasoning);
  assert.deepEqual(f.requests[1].body.input.at(-1), { type: 'function_call_output', call_id: 'call-1', output: 'sample' });
  assert(!f.requests[0].body.tools.some(tool => tool.name === 'write_file'));
  assert.equal(result.usage.input, 50);
  assert.equal(result.usage.cacheWrite, 2);
  assert.equal(result.sessionId, 'resp-2');
});

test('Anthropic uses x-api-key, Messages tool blocks, output_config effort, and additive cache input', async t => {
  const f = fixture(t, (_url, _init, count) => reply(count === 1 ? { id: 'msg-1', content: [{ type: 'tool_use', id: 'tool-1', name: 'list_files', input: { path: '.' } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } : { id: 'msg-2', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } }));
  const provider = await save(f, { protocol: 'anthropic' });
  const result = await f.registry.runProvider({ provider, stage: { role: 'review', effort: 'high' }, prompt: 'List', workspace: f.workspace });
  assert.equal(f.requests[0].init.headers['x-api-key'], 'synthetic-secret-012345');
  assert.equal(f.requests[0].init.headers.Authorization, undefined);
  assert.equal(f.requests[0].init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(f.requests[0].body.output_config, { effort: 'high' });
  assert(f.requests[0].body.tools[0].input_schema);
  assert.equal(f.requests[1].body.messages.at(-1).content[0].tool_use_id, 'tool-1');
  assert.deepEqual(result.usage, { input: 75, output: 8, cacheRead: 25, cacheWrite: 36, reasoning: null, costUSD: null, source: 'api' });
});

test('model capabilities discover supported efforts without inventing them or retaining retired models', async t => {
  const f = fixture(t, () => reply({ data: [{ id: 'live-model', display_name: 'Live', capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true } } } }, { id: 'gone', lifecycle: 'retired' }] }));
  const provider = await save(f, { protocol: 'anthropic' });
  const refreshed = await f.registry.refreshModels(provider.id);
  assert.deepEqual(refreshed.models[0].efforts, ['low', 'high']);
  assert(!refreshed.models.some(model => model.id === 'gone'));
});

test('planning and review cannot write, including an unsolicited tool call', async t => {
  for (const role of ['plan', 'review', 'acceptance']) {
    const f = fixture(t, (_url, _init, count) => reply(count === 1 ? chat('', undefined, [call('write_file', { path: 'forbidden.txt', content: 'x' })]) : chat('done')));
    const provider = await save(f);
    await f.registry.runProvider({ provider, stage: { role }, prompt: 'test', workspace: f.workspace });
    assert.equal(fs.existsSync(path.join(f.workspace, 'forbidden.txt')), false);
    assert(!f.requests[0].body.tools.some(tool => tool.function.name === 'write_file'));
    assert.match(f.requests[1].body.messages.at(-1).content, /只允许读取/);
  }
});

test('filesystem tools reject traversal, symlink files and symlink parent directories', async t => {
  const f = fixture(t, (_url, _init, count) => reply(count === 1 ? chat('', undefined, [
    call('read_file', { path: '../private.txt' }, 'traversal'),
    call('read_file', { path: 'escape' }, 'read-link'),
    call('write_file', { path: 'outside/written.txt', content: 'x' }, 'write-link'),
  ]) : chat('done')));
  fs.writeFileSync(path.join(f.directory, 'private.txt'), 'DO NOT LEAK');
  fs.symlinkSync(path.join(f.directory, 'private.txt'), path.join(f.workspace, 'escape'));
  fs.symlinkSync(f.directory, path.join(f.workspace, 'outside'),process.platform==='win32'?'junction':'dir');
  const provider = await save(f);
  await f.registry.runProvider({ provider, stage: { role: 'execute' }, prompt: 'test', workspace: f.workspace });
  const toolOutputs = f.requests[1].body.messages.filter(message => message.role === 'tool');
  assert.equal(toolOutputs.length, 3);
  assert(toolOutputs.every(output => !output.content.includes('DO NOT LEAK')));
  assert.match(toolOutputs[0].content, /超出工作区/);
  assert.match(toolOutputs[1].content, /符号链接/);
  assert.match(toolOutputs[2].content, /符号链接/);
  assert.equal(fs.existsSync(path.join(f.directory, 'written.txt')), false);
});

test('file limits, unknown command tools, and the 12-round loop are enforced', async t => {
  const f = fixture(t, (_url, _init, count) => reply(chat('', undefined, [call(count === 1 ? 'read_file' : count === 2 ? 'command' : 'list_files', count === 1 ? { path: 'large' } : count === 2 ? { command: 'touch escaped' } : { path: '.' }, `call-${count}`)])));
  fs.writeFileSync(path.join(f.workspace, 'large'), Buffer.alloc(1024 * 1024 + 1));
  const provider = await save(f);
  await assert.rejects(f.registry.runProvider({ provider, prompt: 'test', workspace: f.workspace }), /12 轮/);
  assert.equal(f.requests.length, 12);
  assert.match(f.requests[1].body.messages.at(-1).content, /1 MiB/);
  assert.match(f.requests[2].body.messages.at(-1).content, /不支持此工具/);
  assert.equal(fs.existsSync(path.join(f.workspace, 'escaped')), false);
});

test('cancel works before and during requests; timeout and oversized payloads are bounded', async t => {
  const f = fixture(t, (_url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true }); }));
  const provider = await save(f);
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(f.registry.runProvider({ provider, prompt: 'x', workspace: f.workspace, signal: canceled.signal }), /取消/);
  assert.equal(f.requests.length, 0);
  const controller = new AbortController();
  const pending = f.registry.runProvider({ provider, prompt: 'x', workspace: f.workspace, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /取消/); clearTimeout(timer);
  const slow = fixture(t, (_url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true }); }), { timeoutMs: 50 });
  const slowProvider = await save(slow);
  // Keep the test event loop alive; production timers themselves do not hold app exit.
  const alive = setInterval(() => {}, 100);
  try { await assert.rejects(slow.registry.runProvider({ provider: slowProvider, prompt: 'x', workspace: slow.workspace }), /超时/); } finally { clearInterval(alive); }
  const huge = fixture(t, () => new Response('x'.repeat(4 * 1024 * 1024 + 1)));
  const hugeProvider = await save(huge);
  await assert.rejects(huge.registry.refreshModels(hugeProvider.id), /大小限制/);
});

test('text output is redacted and unknown usage remains unknown', async t => {
  const f = fixture(t, () => reply(chat('key: synthetic-secret-012345', {})));
  const provider = await save(f);
  const result = await f.registry.runProvider({ provider, prompt: 'test', workspace: f.workspace });
  assert.equal(result.text, 'key: [redacted]');
  assert.equal(result.usage.input, null);
  assert.equal(result.usage.costUSD, null);
});

test('runtime authentication rejection immediately withdraws saved provider and model readiness', async t => {
  const f = fixture(t, (_url, _init, count) => count === 1 ? reply({ data: [{ id: 'custom-model' }] }) : reply({ error: 'invalid key' }, 401));
  let provider = await save(f);
  provider = await f.registry.refreshModels(provider.id);
  assert.equal(provider.ready, true);
  await assert.rejects(f.registry.runProvider({ provider, stage: { role: 'plan' }, prompt: 'test', workspace: f.workspace }), /401/);
  const current = f.registry.getProviders()[0];
  assert.equal(current.ready, false);
  assert(current.models.every(model => model.ready === false));
  const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'api-providers.json'), 'utf8')).providers[0];
  assert.equal(saved.ready, false);
});

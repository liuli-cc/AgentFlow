'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const {
  Engine, validateConfig, validateWorkspace, redact, aggregateUsage,
  normalizedUsage, createDefaultConfig, parseVerdict,
} = require('../lib/engine.cjs');

const FIXTURE_ROOT = path.resolve(__dirname, '../../../work/security-tests');
const VERDICT = JSON.stringify({ passed: true, summary: '实际文件和检查均符合需求',
  checks: [{ name: '产物检查', passed: true, evidence: '检查了工作目录中的交付文件与运行结果' }] });
const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0,
  reasoning: 0, costUSD: 0, source: '回归测试中的结构化运行事件' });
const providers = () => ['codex', 'claude', 'workbuddy', 'codebuddy', 'dsh', 'marvis'].map(id => ({
  id, name: id, ready: true, installed: true, mode: 'cli', executable: '/not-launched-by-engine-test',
  models: [{ id: 'gpt-test', efforts: ['low', 'high'] }], efforts: ['default', 'low', 'high'],
}));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject }; };

async function waitFor(predicate, explanation = '预期状态', milliseconds = 3000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时：${explanation}`);
}

async function fixture(t, runProvider, discovered = providers()) {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'case-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const dataDir = path.join(root, 'state');
  let config;
  const implementation=runProvider || (async ({ stage }) => ({ text: stage.role === 'review' ? VERDICT : `${stage.role} 实际结果`, usage: usage(10, 2) }));
  const engine = new Engine({ dataDir, detectProviders: () => discovered,
    runProvider: async args => args.stage.id === 'starter' ? {text:JSON.stringify({title:'测试任务',stages:config.stages.map(s=>({...s,provider:'codex',model:'',effort:'default'}))}),usage:usage(0,0)} : implementation(args) });
  await engine.init();
  t.after(() => { engine.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  config = createDefaultConfig();
  config.workspace = workspace;
  config.prompt = '在所选目录生成一个可核验的交付文件';
  config.stages = config.stages.filter(stage => stage.role !== 'design').map(stage => ({ ...stage, provider: 'codex', model:'', effort:'default' }));
  const current = id => engine.getState().runs.find(run => run.id === id);
  return { root, workspace, dataDir, engine, config, current };
}

async function startConfirmed(f, config) {
  const run=await f.engine.startRun(config);
  await waitFor(()=>f.current(run.id)?.status==='awaiting_confirmation','启动模型完成推荐');
  await f.engine.confirmWorkflow({runId:run.id,stages:config.stages});
  return run;
}
async function finish(f, runId, explanation) {
  const reviewed=await waitFor(()=>f.current(runId)?.status==='awaiting_acceptance'&&f.current(runId), explanation);
  assert.equal(reviewed.requiresHumanAcceptance,true);
  assert.equal(reviewed.humanDecision,undefined);
  f.engine.confirmResult({runId,accepted:true});
  return f.current(runId);
}

test('配置拒绝选项、命令和阶段标识注入，同时保留用户需求为数据', async t => {
  const f = await fixture(t);
  f.config.prompt = '保留此需求原文：$(touch unwanted); `echo unsafe` <script>bad()</script>';
  assert.equal(validateConfig(f.config).prompt, f.config.prompt);
  for (const malicious of ['--dangerously-bypass-approvals', 'model; touch injected', 'model\n--flag', 'model\0tail']) {
    const config = structuredClone(f.config); config.stages[1].model = malicious;
    assert.throws(() => validateConfig(config), undefined, `应拒绝模型值 ${JSON.stringify(malicious)}`);
  }
  for (const changed of [
    { provider: 'shell; injected' }, { role: 'arbitrary' }, { id: '../../escaped' }, { effort: 'high; unsafe' },
  ]) {
    const config = structuredClone(f.config); Object.assign(config.stages[1], changed);
    assert.throws(() => validateConfig(config));
  }
  const duplicate = structuredClone(f.config); duplicate.stages[1].id = duplicate.stages[0].id;
  assert.throws(() => validateConfig(duplicate));
  const noReview = structuredClone(f.config); noReview.stages[2].enabled = false;
  assert.throws(() => validateConfig(noReview));
});

test('目录边界解析符号链接并拒绝系统目录、凭据目录、文件和相对路径', async t => {
  const f = await fixture(t);
  const fakeHome = path.join(f.root, 'home'); fs.mkdirSync(fakeHome);
  const credentials = path.join(fakeHome, '.ssh'); fs.mkdirSync(credentials);
  const link = path.join(f.root, 'innocent-name'); fs.symlinkSync(credentials, link, process.platform==='win32'?'junction':'dir');
  const regularFile = path.join(f.root, 'file'); fs.writeFileSync(regularFile, 'x');
  assert.equal(validateWorkspace(f.workspace), fs.realpathSync(f.workspace));
  assert.throws(() => validateWorkspace(link, { home: fakeHome }));
  assert.throws(() => validateWorkspace(fakeHome, { home: fakeHome }));
  assert.throws(() => validateWorkspace('/'));
  assert.throws(() => validateWorkspace('/Applications'));
  assert.throws(() => validateWorkspace(regularFile));
  assert.throws(() => validateWorkspace('../relative'));
});

test('敏感赋值和 Bearer 值均脱敏，不以凭据长度判断是否敏感', () => {
  const samples = [
    ['password=abc', 'abc'], ['secret=xyz', 'xyz'], ['Bearer abc123', 'abc123'],
    ['api_key=synthetic-test-value', 'synthetic-test-value'],
    ['{"refresh_token":"synthetic-refresh-value"}', 'synthetic-refresh-value'],
    ['sk-proj-syntheticCredential123456789', 'syntheticCredential123456789'],
  ];
  for (const [input, sensitive] of samples) assert.ok(!redact(input).includes(sensitive), `未隐藏 ${input.split(/[=: ]/)[0]}`);
  assert.equal(redact('正常的中文结果 123'), '正常的中文结果 123');
});

test('用量区分真实零和未知值，拒绝非法计量而不凭空补零', () => {
  const absent = normalizedUsage(undefined);
  assert.equal(absent.input, null); assert.equal(absent.output, null);
  assert.equal(aggregateUsage([{ input: null }, { input: undefined }]).input, null);
  const validZero = normalizedUsage(usage(0, 0));
  assert.equal(validZero.input, 0); assert.equal(validZero.cacheRead, 0);
  const invalid = normalizedUsage({ input: -1, output: Infinity, costUSD: NaN, cacheRead: '12' });
  assert.equal(invalid.input, null); assert.equal(invalid.output, null);
  assert.equal(invalid.costUSD, null); assert.equal(invalid.cacheRead, null);
  const partial = aggregateUsage([usage(10, 2), {}]);
  assert.equal(partial.input, 10); assert.equal(partial.partial, true);
  const cachePartial = aggregateUsage([usage(10, 2), { input: 8, output: 1, cacheRead: null }]);
  assert.equal(cachePartial.partial, true);
  assert.ok(cachePartial.partialFields.includes('cacheRead'));
});

test('验收须为有证据的结构化全通过结论', () => {
  assert.equal(parseVerdict(VERDICT).passed, true);
  for (const text of ['done', '{}', '{"passed":true}',
    '{"passed":true,"summary":"完成","checks":[]}',
    '{"passed":true,"summary":"完成","checks":[{"name":"x","passed":true,"evidence":""}]}',
    '{"passed":true,"summary":"完成","checks":[{"name":"x","passed":false,"evidence":"失败"}]}']) {
    assert.equal(parseVerdict(text).passed, false);
  }
});

test('确认后按规划、执行、模型验收顺序运行，人工验收后才完成', async t => {
  const called = [];
  const f = await fixture(t, async ({ stage }) => { called.push(stage.role);
    return { text: stage.role === 'review' ? VERDICT : '真实输出', usage: usage(12, 3) }; });
  const started = await startConfirmed(f, f.config);
  const run = await finish(f, started.id, '人工确认成功验收');
  assert.deepEqual(called, ['plan', 'execute', 'review']);
  assert.equal(run.verdict.passed, true); assert.ok(run.finalText);
  assert.equal(f.engine.getState().activeRunId, null);
  assert.ok(run.stages.every(stage => stage.status === 'completed'));
});

test('非结构化模型验收和有效的否决结论都不会变成成功终态', async t => {
  for (const reviewText of ['已全部做好，请放心使用', JSON.stringify({ passed: false, summary: '尚缺检查证据',
    checks: [{ name: '运行检查', passed: false, evidence: '未执行测试' }] })]) {
    const f = await fixture(t, async ({ stage }) => ({ text: stage.role === 'review' ? reviewText : '真实输出', usage: usage(1, 1) }));
    const started = await startConfirmed(f, f.config);
    const run = await waitFor(() => f.current(started.id)?.status === 'review_failed' && f.current(started.id), '验收失败');
    assert.equal(run.verdict.passed, false); assert.equal(f.engine.getState().activeRunId, null);
  }
});

test('执行器报错时保留错误和用量，不调用后续验收', async t => {
  const called = [];
  const f = await fixture(t, async ({ stage, onEvent }) => {
    called.push(stage.role); onEvent({ type: 'usage', usage: usage(9, 2) });
    throw new Error('synthetic failure password=abcd');
  });
  const started = await startConfirmed(f, f.config);
  const run = await waitFor(() => f.current(started.id)?.status === 'failed' && f.current(started.id), '执行错误');
  assert.deepEqual(called, ['plan']); assert.equal(run.stages[0].usage.input, 9);
  assert.equal(run.stages[0].attempts[0].status, 'failed');
  assert.ok(!run.stages[0].error.includes('abcd'));
});

test('未就绪入口必须先登录，确认和人工交接均不能绕过连接验证', async t => {
  const discovered = providers(); const disconnected = discovered.find(item => item.id === 'codebuddy');
  Object.assign(disconnected, { ready: false, mode: 'handoff' });
  const calls = [];
  const f = await fixture(t, async ({ stage }) => { calls.push(stage.role); return {
    text: stage.role === 'review' ? VERDICT : '实际结果', usage: usage(2, 1),
  }; }, discovered);
  const started = await f.engine.startRun(f.config);
  await waitFor(() => f.current(started.id)?.status === 'awaiting_confirmation', '等待确认');
  const invalid = structuredClone(f.config.stages); invalid[1].provider = 'codebuddy';
  await assert.rejects(f.engine.confirmWorkflow({runId:started.id,stages:invalid}), /登录|就绪/);
  assert.deepEqual(calls, []);
  assert.throws(() => f.engine.completeHandoff({runId:started.id,stageId:'execute',text:'完成'}));
  assert.equal(f.current(started.id).status, 'awaiting_confirmation');
  await f.engine.confirmWorkflow({runId:started.id,stages:f.config.stages});
  await finish(f,started.id,'更换为已验证入口后完成');
  assert.deepEqual(calls,['plan','execute','review']);
});

test('未登录启动模型不能调用模型或用人工回执绕过认证', async t => {
  const discovered = providers(); discovered.find(item => item.id === 'codex').ready = false;
  let called = 0;
  const f = await fixture(t, async () => { called++; return { text: VERDICT }; }, discovered);
  await assert.rejects(f.engine.startRun(f.config), /尚未可用/);
  assert.equal(called, 0);
  assert.equal(f.engine.getState().runs.length, 0);
});

test('暂停等待当前环节结束，可调整后续环节但不能改写进行中的调用', async t => {
  const gate = deferred(); const calls = [];
  const f = await fixture(t, async ({ stage }) => {
    calls.push({ role: stage.role, model: stage.model, effort: stage.effort });
    if (stage.role === 'plan') await gate.promise;
    return { text: stage.role === 'review' ? VERDICT : '真实结果', usage: usage(5, 1) };
  });
  const started = await startConfirmed(f, f.config);
  await waitFor(() => calls.length === 1, '规划开始');
  f.engine.controlRun({ runId: started.id, action: 'pause' });
  assert.throws(() => f.engine.updateStage({ runId: started.id, stageId: 'plan', effort: 'high' }));
  gate.resolve();
  await waitFor(() => f.current(started.id)?.status === 'paused', '环节边界暂停');
  assert.equal(calls.length, 1);
  f.engine.updateStage({ runId: started.id, stageId: 'execute', model: 'gpt-test', effort: 'high' });
  f.engine.updateStage({ runId: started.id, stageId: 'review', provider: 'claude' });
  f.engine.controlRun({ runId: started.id, action: 'resume' });
  await finish(f, started.id, '恢复完成');
  assert.equal(calls[1].model, 'gpt-test'); assert.equal(calls[1].effort, 'high');
  assert.equal(f.current(started.id).stages[0].usage.input, 5);
});

test('后续环节拒绝被替换为另一个目录的工作区符号链接', async t => {
  const called = [];
  const f = await fixture(t, async ({ stage }) => { called.push(stage.role);
    return { text: stage.role === 'review' ? VERDICT : '已完成本阶段', usage: usage(1, 1) }; });
  f.config.pauseBetweenStages = true;
  const started = await startConfirmed(f, f.config);
  await waitFor(() => f.current(started.id)?.status === 'paused', '规划完成后暂停');
  const renamed = path.join(f.root, 'original-project');
  const outside = path.join(f.root, 'not-selected'); fs.mkdirSync(outside);
  fs.renameSync(f.workspace, renamed); fs.symlinkSync(outside, f.workspace, process.platform==='win32'?'junction':'dir');
  f.engine.controlRun({ runId: started.id, action: 'resume' });
  const run = await waitFor(() => f.current(started.id)?.status === 'failed' && f.current(started.id), '拒绝替换后的目录');
  assert.equal(run.status, 'failed'); assert.deepEqual(called, ['plan']);
});

test('取消向实际执行器发出中止信号，重试保留此前已产生用量', async t => {
  let calls = 0, abortSeen = false;
  const f = await fixture(t, async ({ stage, signal, onEvent }) => {
    if (stage.role === 'plan' && ++calls === 1) {
      onEvent({ type: 'usage', usage: usage(11, 3) });
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        abortSeen = true; reject(new Error('cancelled by engine signal'));
      }, { once: true }));
    }
    return { text: stage.role === 'review' ? VERDICT : '重试的真实结果', usage: usage(20, 4) };
  });
  const started = await startConfirmed(f, f.config);
  await waitFor(() => calls === 1, '执行器已启动');
  f.engine.controlRun({ runId: started.id, action: 'cancel' });
  const cancelled = await waitFor(() => f.current(started.id)?.status === 'cancelled' && f.current(started.id), '取消完成');
  assert.equal(abortSeen, true); assert.equal(cancelled.stages[0].usage.input, 11);
  assert.equal(cancelled.stages[0].attempts[0].status, 'cancelled');
  f.engine.controlRun({ runId: started.id, action: 'retry' });
  const retried = await finish(f, started.id, '取消后重试');
  assert.equal(retried.stages[0].attempts.length, 2);
  assert.equal(retried.stages[0].usage.input, 31); assert.equal(retried.stages[0].usage.output, 7);
});

test('验收失败后重跑执行与验收，保留规划、历史尝试及用量', async t => {
  const calls = []; let reviews = 0;
  const f = await fixture(t, async ({ stage }) => {
    calls.push(stage.role);
    const text = stage.role === 'review' ? (++reviews === 1 ? JSON.stringify({ passed: false, summary: '缺少产物',
      checks: [{ name: '产物', passed: false, evidence: '本次未找到文件' }] }) : VERDICT) : '真实阶段结果';
    return { text, usage: usage(7, 2) };
  });
  const started = await startConfirmed(f, f.config);
  await waitFor(() => f.current(started.id)?.status === 'review_failed', '首次验收失败');
  f.engine.controlRun({ runId: started.id, action: 'retry' });
  const run = await finish(f, started.id, '修复后验收通过');
  assert.deepEqual(calls, ['plan', 'execute', 'review', 'execute', 'review']);
  assert.equal(run.stages[0].attempts.length, 1); assert.equal(run.stages[1].usage.input, 14);
  assert.equal(run.stages[2].attempts.length, 2); assert.equal(run.stages[2].usage.input, 14);
});

test('成功响应未重复提供 usage 时仍保留已流式收到的真实用量', async t => {
  const f = await fixture(t, async ({ stage, onEvent }) => {
    onEvent({ type: 'usage', usage: usage(17, 4) });
    return { text: stage.role === 'review' ? VERDICT : '真实结果' };
  });
  const started = await startConfirmed(f, f.config);
  const run = await finish(f, started.id, '流式用量持久化');
  for (const stage of run.stages) {
    assert.equal(stage.usage.input, 17); assert.equal(stage.usage.output, 4);
    assert.equal(stage.attempts[0].usage.input, 17);
  }
});

test('重启将未完任务标记中断，不自动执行或假定成功', async t => {
  const f = await fixture(t);
  const runId = '01234567-89ab-4cde-8fab-0123456789ab';
  const interrupted = { id: runId, workspace: f.workspace, prompt: '先前未完成的任务', status: 'running',
    stages: f.config.stages.map((stage, index) => ({ ...stage, status: index === 0 ? 'running' : 'pending',
      text: '', usage: usage(5, 1), attempts: [], error: null })), events: [], finalText: '' };
  fs.writeFileSync(path.join(f.dataDir, 'runs', `${runId}.json`), JSON.stringify(interrupted));
  let called = 0;
  const restored = new Engine({ dataDir: f.dataDir, detectProviders: providers,
    runProvider: async () => { called++; return { text: VERDICT }; } });
  await restored.init(); t.after(() => restored.shutdown());
  const run = restored.getState().runs.find(item => item.id === runId);
  assert.equal(run.status, 'interrupted'); assert.equal(run.stages[0].status, 'failed');
  assert.equal(restored.getState().activeRunId, null); assert.equal(called, 0);
});

test('关闭并重启后，已中断任务的阶段与尝试不继续显示运行中', async t => {
  let started = false;
  const f = await fixture(t, async ({ signal, onEvent }) => {
    started = true; onEvent({ type: 'usage', usage: usage(6, 1) });
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('应用关闭')), { once: true }));
    return { text: '不应到达' };
  });
  const run = await startConfirmed(f, f.config);
  await waitFor(() => started, '待关闭的真实执行任务');
  f.engine.shutdown();
  const restored = new Engine({ dataDir: f.dataDir, detectProviders: providers,
    runProvider: async () => { throw new Error('重启不应自动启动外部执行'); } });
  await restored.init(); t.after(() => restored.shutdown());
  const saved = restored.getState().runs.find(item => item.id === run.id);
  assert.notEqual(saved.status, 'completed');
  assert.ok(saved.stages.every(stage => stage.status !== 'running'));
  assert.ok(saved.stages.flatMap(stage => stage.attempts || []).every(attempt => attempt.status !== 'running'));
  assert.equal(saved.stages[0].usage.input, 6);
});

test('快照不泄露执行器环境，状态文件只允许当前用户读写', async t => {
  const discovered = providers(); discovered[0].env = { SYNTHETIC_SECRET: 'never-render-this-value' };
  const f = await fixture(t, undefined, discovered);
  const started = await startConfirmed(f, f.config);
  await finish(f, started.id, '结果保存');
  const state = f.engine.getState();
  assert.equal(state.providers[0].env, undefined); assert.equal(state.providers[0].executable, undefined);
  state.runs[0].status = 'tampered'; assert.equal(f.current(started.id).status, 'completed');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f.dataDir, 'config.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(f.dataDir, 'runs', `${started.id}.json`)).mode & 0o777, 0o600);
  }
});

test('桌面权限与 IPC 来源检查拒绝其他页面、子框架、网络及新窗口', () => {
  const mainFile = path.resolve(__dirname, '../main.cjs');
  const actualRequire = createRequire(mainFile);
  const ipcHandlers = new Map(); let windowOptions;
  const listeners = new Map(); const hooks = {};
  const frame = { url: pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href };
  const contents = {
    id: 71, mainFrame: frame,
    setWindowOpenHandler: callback => { hooks.openWindow = callback; },
    on: (name, callback) => listeners.set(name, callback),
    once: (name, callback) => listeners.set(name, callback),
    session: {
      setPermissionRequestHandler: callback => { hooks.permission = callback; },
      setPermissionCheckHandler: callback => { hooks.permissionCheck = callback; },
      webRequest: { onBeforeRequest: (filter, callback) => { hooks.request = callback; } },
    },
  };
  class FakeWindow {
    constructor(options) { windowOptions = options; this.webContents = contents; }
    once() {} on() {} loadFile() { return Promise.resolve(); } show() {}
  }
  const electron = {
    app: { setName() {}, requestSingleInstanceLock: () => true, on() {},
      whenReady: () => ({ then: () => ({ catch() {} }) }) },
    BrowserWindow: FakeWindow, ipcMain: { handle: (name, fn) => ipcHandlers.set(name, fn) },
    dialog: {}, shell: {}, clipboard: {}, nativeTheme: {},
  };
  const context = {
    require: name => name === 'electron' ? electron : actualRequire(name),
    __dirname: path.dirname(mainFile), module: { exports: {} },
    process: { env: {}, resourcesPath: path.dirname(mainFile), platform: 'darwin', execPath: process.execPath },
    Buffer, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8') + '\n;globalThis.securityBoundary={createWindow,assertSender};', context, { filename: mainFile });
  context.securityBoundary.createWindow();
  const preferences = windowOptions.webPreferences;
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true); assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.allowRunningInsecureContent, false);
  const validEvent = { sender: contents, senderFrame: frame };
  assert.doesNotThrow(() => context.securityBoundary.assertSender(validEvent));
  assert.throws(() => context.securityBoundary.assertSender({ ...validEvent, sender: { id: 72 } }));
  assert.throws(() => context.securityBoundary.assertSender({ ...validEvent, senderFrame: { url: frame.url } }));
  const previousURL = frame.url; frame.url = 'https://untrusted.invalid/';
  assert.throws(() => context.securityBoundary.assertSender(validEvent)); frame.url = previousURL;
  let permission;
  hooks.permission(contents, 'media', result => { permission = result; });
  assert.equal(permission, false); assert.equal(hooks.permissionCheck(), false);
  let networkCancelled;
  hooks.request({ url: 'https://untrusted.invalid/' }, result => { networkCancelled = result.cancel; });
  assert.equal(networkCancelled, true); assert.equal(hooks.openWindow().action, 'deny');
  let prevented = 0;
  listeners.get('will-navigate')({ preventDefault: () => prevented++ }, 'https://untrusted.invalid/');
  listeners.get('will-attach-webview')({ preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
});

'use strict';

// Only public CLI entry points and installed connector APIs are used.
// Credentials stay inside their owning CLI/connector and never enter renderer metadata.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { pathToFileURL } = require('node:url');
const { prepareVendorInvocation } = require('./vendor-auth.cjs');
const { findCLI, resolveCLIInvocation, terminateProcessTree, windowsApplicationRoots } = require('./runtime.cjs');
const googleAgents = require('./google-agents.cjs');

const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const TIMEOUT = 30 * 60 * 1000;
const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'costUSD'];
const emptyUsage = () => Object.fromEntries(USAGE_KEYS.map(key => [key, null]));
const exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const appExists = file => { try { return fs.statSync(file).isDirectory(); } catch { return false; } };
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const firstNumber = (...values) => { for (const value of values) { const n = nonnegative(value); if (n !== null) return n; } return null; };
const metadataCache = new Map();
const SAFE_EFFORTS = new Set(['default', 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const safeEfforts = values => ['default', ...new Set((Array.isArray(values) ? values : []).filter(value => value !== 'default' && SAFE_EFFORTS.has(value)))];
const safeModelId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.startsWith('-') && !/[\u0000-\u001f]/.test(value);

function readJSON(file, maximum = 4 * 1024 * 1024) {
  try { if (fs.statSync(file).size > maximum) return null; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Private, process-local resolution wrapper. The user's plugin and installed
// DSH runtime remain untouched, including old or dangling profile symlinks.
function dshImportPrelude(runtimeRoot) {
  return `import { registerHooks } from 'node:module';\n` +
    `const agentflowRuntime = ${JSON.stringify(pathToFileURL(path.join(runtimeRoot, 'package.json')).href)};\n` +
    `registerHooks({ resolve(specifier, context, nextResolve) {\n` +
    `  return specifier.startsWith('@deepseek-ai/') ? nextResolve(specifier, { ...context, parentURL: agentflowRuntime }) : nextResolve(specifier, context);\n` +
    `} });\n`;
}

function findDshConnector(home, dshHome=path.join(home,'.dsh')) {
  const profiles = path.join(dshHome, 'profiles');
  let directories = [];
  try { directories = fs.readdirSync(profiles, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.includes('backup')).map(entry => entry.name); } catch { return null; }
  directories.sort((a, b) => (a === 'desktop' ? -1 : b === 'desktop' ? 1 : a.localeCompare(b)));
  for (const profile of directories) {
    const directory = path.join(profiles, profile, 'node_modules', 'dsh-workbuddy-connect');
    const pkg = readJSON(path.join(directory, 'package.json'), 256 * 1024);
    const entry = path.join(directory, 'lib', 'index.js');
    if (pkg?.name === 'dsh-workbuddy-connect' && exists(entry)) return { entry, profile, dshHome, version: typeof pkg.version === 'string' ? pkg.version : 'unknown' };
  }
  return null;
}

function connectorMetadataScript(connector, runtimeRoot, refreshModels) {
  return dshImportPrelude(runtimeRoot) + `
const connector = await import(${JSON.stringify(pathToFileURL(connector.entry).href)});
const allowedEfforts = new Set(['off','minimal','low','medium','high','xhigh','max']);
const variants = [];
for (const variant of connector.WORKBUDDY_VARIANTS) {
  const client = new connector.WorkBuddyUpstreamClient();
  const store = new connector.WorkBuddyCredentialStore({variant, refresh: value => client.refreshToken(value)});
  let credential, authStatus='unknown';
  try { credential = typeof store.resolve==='function' ? await store.resolve() : await store.current(); authStatus=credential?'configured':'required'; }
  catch { authStatus='unavailable'; }
  const account = credential ? connector.visibilityAccountOf(credential) : undefined;
  const saved = account ? new connector.WorkBuddyCatalogStore(connector.workbuddyCatalogPath(variant.catalogFilename)).get(account) : undefined;
  let models = saved?.models || [];
  let state = credential ? 'configured-cached' : 'signed-out';
  let fetchedAt = saved?.fetchedAtMs;
  if (${refreshModels === true} && credential) {
    try {
      models = await client.fetchModels(credential, AbortSignal.timeout(8000));
      state = 'available'; fetchedAt = Date.now();
    } catch { state = models.length ? 'configured-cached' : 'unavailable'; }
  }
  const probes = new connector.WorkBuddyProbeStore({pluginVersion:${JSON.stringify(connector.version)},path:connector.workbuddyProbePath(variant.probeFilename)});
  const rows = models.filter(info => typeof info.id === 'string' && typeof info.name === 'string').map(info => {
    const reasoning = info.reasoning;
    const declared = Array.isArray(reasoning?.supportedEfforts) ? reasoning.supportedEfforts : [];
    const observed = account ? probes.get(info.id, connector.fingerprintModel(info), account) : undefined;
    let efforts = reasoning?.supports === true ? (declared.length ? declared : observed?.validation === 'validating' ? observed.efforts : []) : [];
    efforts = efforts.filter(value => allowedEfforts.has(value));
    if (declared.length && reasoning?.canDisableThinking === true && (variant.region !== 'cn' || reasoning.onlyReasoning !== true)) efforts = ['off', ...efforts];
    return {id:info.id,label:info.name,efforts:['default',...new Set(efforts)],ready:!!credential,availability:state,
      source:{kind:'connector-catalog',provider:variant.id,state,fetchedAt:fetchedAt||null,profile:${JSON.stringify(connector.profile)},connectorVersion:${JSON.stringify(connector.version)}}};
  });
  variants.push({providerRoute:variant.id,label:variant.displayName,ready:!!credential,authStatus,models:rows});
}
console.log(JSON.stringify({variants}));
`;
}

function readDshConnectorMetadata({ home, dshApp, workbuddyApp, refreshModels = false, platform = process.platform, environment=process.env }) {
  const dshHome=typeof environment.DSH_HOME==='string'&&path.isAbsolute(environment.DSH_HOME)?environment.DSH_HOME:path.join(home,'.dsh');
  const connector = findDshConnector(home,dshHome);
  if (!connector) return { connector: null, variants: [] };
  const signatureFiles = ['.workbuddy-ai-catalog.json', '.workbuddy-catalog.json', '.workbuddy-ai-probe.json', '.workbuddy-probe.json',
    '.workbuddy-ai-auth.json', '.workbuddy-auth.json'].map(name => path.join(dshHome, name));
  const desktopRoots=platform==='win32'?[environment.LOCALAPPDATA||path.join(home,'AppData','Local'),environment.APPDATA||path.join(home,'AppData','Roaming')]:[path.join(home,'Library','Application Support')];
  for(const root of desktopRoots)for(const name of ['workbuddy-desktop-ai.info','workbuddy-desktop.info']){const file=path.join(root,'CodeBuddyExtension','Data','Public','auth',name);signatureFiles.push(file,file+'.logged-out');}
  const signature = signatureFiles.map(file => { try { const value = fs.statSync(file); return `${value.mtimeMs}/${value.size}`; } catch { return 'absent'; } }).join(':');
  const cacheKey = `${platform}:${home}:${dshApp}:${workbuddyApp}:${connector.entry}:${signature}`;
  const cached = metadataCache.get(cacheKey);
  if (!refreshModels && cached && Date.now() - cached.at < 60_000) return cached.value;
  const resources=dshApp?(platform==='darwin'?path.join(dshApp,'Contents','Resources'):path.join(path.dirname(dshApp),'resources')):null;
  const runtimeRoot = resources ? path.join(resources, 'app.asar', 'dsh') : null;
  const executable = dshApp ? platform==='darwin'?path.join(dshApp,'Contents','MacOS','DeepSeek Harness'):dshApp : null;
  let variants = [];
  // Electron's patched fs represents an ASAR archive root as a directory.
  // Requiring isFile() here skipped the real credential/catalog check only
  // inside the packaged desktop app, leaving every external model unverified.
  if (runtimeRoot && exists(executable) && fs.existsSync(path.join(resources,'app.asar'))) {
    const env = { ...providerEnvironment('dsh',{environment,home,platform}), DSH_HOME:dshHome, ELECTRON_RUN_AS_NODE: '1' };
    const workbuddyElectron = workbuddyApp ? platform==='darwin'?path.join(workbuddyApp,'Contents','MacOS','Electron'):workbuddyApp : '';
    if (exists(workbuddyElectron)) env.WORKBUDDY_AI_ELECTRON_BIN = workbuddyElectron;
    try {
      const result = spawnSync(executable, ['--expose-internals', '--input-type=module', '-e', connectorMetadataScript(connector, runtimeRoot, refreshModels)],
        { env, encoding: 'utf8', shell: false, timeout: refreshModels ? 20000 : 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      if (result.status === 0) {
        const output = JSON.parse(result.stdout.trim());
        variants = Array.isArray(output.variants) ? output.variants.filter(variant => ['workbuddy', 'workbuddy-ai'].includes(variant.providerRoute)) : [];
      }
    } catch { /* no credentials or diagnostic output is exposed to the renderer */ }
  }
  if (!variants.length) {
    // A readable cache is evidence of a roster, never evidence of current login.
    for (const [route, file, label] of [['workbuddy-ai', '.workbuddy-ai-catalog.json', 'WorkBuddy AI'], ['workbuddy', '.workbuddy-catalog.json', 'WorkBuddy']]) {
      const saved = readJSON(path.join(dshHome, file));
      const entries = Object.values(saved?.entries || {}).filter(entry => Array.isArray(entry?.models)).sort((a, b) => (b.fetchedAtMs || 0) - (a.fetchedAtMs || 0));
      if (!entries.length) continue;
      variants.push({ providerRoute: route, label, ready: false, models: entries[0].models.filter(model => safeModelId(model.id)).map(model => ({
        id: model.id, label: typeof model.name === 'string' ? model.name : model.id,
        efforts: safeEfforts(model.reasoning?.supportedEfforts), ready: false, availability: 'unknown-account',
        source: { kind: 'connector-catalog', state: 'unverified', profile: connector.profile, fetchedAt: entries[0].fetchedAtMs || null },
      })) });
    }
  }
  const value = { connector: runtimeRoot ? { ...connector, runtimeRoot, ...(workbuddyApp ? {workbuddyAppPath:workbuddyApp} : {}) } : null, variants };
  metadataCache.set(cacheKey, { at: Date.now(), value });
  if (metadataCache.size > 12) metadataCache.delete(metadataCache.keys().next().value);
  return value;
}

function findExecutable(name, extra = [], options = {}) {
  return findCLI(name, { extra, ...options });
}

function inspectCommand(command, args, env = process.env, nodePath = process.execPath) {
  if (!command) return null;
  try {
    const invocation = resolveCLIInvocation({ executable: command, args, env, nodePath });
    const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', shell: false, timeout: 5000,
      maxBuffer: 1024 * 1024, env: invocation.env, windowsHide: true });
    return { status: result.status, output: `${result.stdout || ''}\n${result.stderr || ''}` };
  } catch { return null; }
}

function readCodexModels(home, environment = process.env) {
  try {
    const configured=environment.CODEX_HOME;
    const root=typeof configured==='string'&&path.isAbsolute(configured)&&!/[\u0000-\u001f]/.test(configured)?configured:path.join(home,'.codex');
    const file = path.join(root, 'models_cache.json');
    if (fs.statSync(file).size > 2 * 1024 * 1024) return [];
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (cache.models || []).filter(model => model.visibility === 'list' && typeof model.slug === 'string')
      .map(model => ({ id: model.slug, label: model.display_name || model.slug,
        efforts: safeEfforts((model.supported_reasoning_levels || []).map(value => value.effort)),
        source: { kind: 'codex-model-cache', fetchedAt: cache.fetched_at || null } }));
  } catch { return []; }
}

function readOpenCodeMetadata({ home, appPath, executable, platform = process.platform, env: environment = process.env, nodePath }) {
  if (!executable) return { models: [], accountConfigured: false, status: 'cli-unavailable' };
  // The desktop normally uses the shared background service. --standalone is a
  // different server context and can incorrectly return an empty provider list.
  const configRoot = platform === 'win32' ? environment.APPDATA || path.join(home,'AppData','Roaming') : path.join(home,'Library','Application Support');
  const settings = readJSON(path.join(configRoot,'ai.opencode.desktop/opencode.settings'), 1024 * 1024);
  const args = [];let serverContext = 'shared-background-service';
  if (typeof settings?.defaultServerUrl === 'string' && settings.defaultServerUrl) {
    let server;
    try { server = new URL(settings.defaultServerUrl); } catch { return { models: [], accountConfigured: false, status: 'server-selection-unavailable' }; }
    if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash
        || !['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)) return { models: [], accountConfigured: false, status: 'server-selection-unavailable' };
    args.push('--server', server.origin);serverContext = 'desktop-selected-local-server';
  }
  const env = providerEnvironment('opencode',{environment,home,platform});
  const auth = inspectCommand(executable, ['auth', 'list', ...args, '--format', 'json'], env, nodePath);
  let accountConfigured = false;
  try { const rows = JSON.parse(auth?.output.trim());accountConfigured = auth.status === 0 && Array.isArray(rows) && rows.length > 0; } catch { /* no claim about client login */ }
  const result = inspectCommand(executable, ['models', ...args], env, nodePath);
  const models = result?.status === 0 ? result.output.split(/\r?\n/).map(id => id.trim()).filter(id => /^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s#]+(?:#[^\s]+)?$/.test(id) && safeModelId(id)).slice(0, 200) : [];
  return { models: [...new Set(models)], accountConfigured, serverContext,
    freeClientOnly: !accountConfigured && models.length > 0 && models.every(id => /^opencode\/(?:big-pickle|[^#]+-free)(?:#.*)?$/.test(id)),
    status: result?.status === 0 ? 'catalog-observed' : 'catalog-unavailable' };
}

function validatedCodeBuddyCLI(cliPath) {
  if (typeof cliPath !== 'string' || !path.isAbsolute(cliPath) || /[\u0000-\u001f]/.test(cliPath)) return null;
  try {
    const executable = fs.realpathSync(cliPath), directory = path.dirname(path.dirname(executable));
    const pkg = readJSON(path.join(directory, 'package.json'), 512 * 1024);
    if (path.basename(executable) !== 'codebuddy' || path.basename(path.dirname(executable)) !== 'bin'
        || pkg?.name !== '@tencent-ai/codebuddy-code' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version || '')
        || typeof pkg.bin?.codebuddy !== 'string' || path.resolve(directory, pkg.bin.codebuddy) !== executable || !exists(executable)) return null;
    return { executable, packageName: pkg.name, packageVersion: pkg.version };
  } catch { return null; }
}

function detectProviders({ home = os.homedir(), nodePath = process.execPath, refreshModels = false, discoveredProviders = [], codebuddyCLIPath, platform = process.platform, env = process.env } = {}) {
  const lookup = (name, extra = []) => findExecutable(name, extra, { home, platform, env });
  const winApp = (names, executables) => windowsApplicationRoots({home,env}).flatMap(root => names.flatMap(name => executables.map(executable => path.join(root,name,executable)))).find(exists) || null;
  const downloadedApplication=candidate=>{if(candidate?.executionTrust==='untrusted-discovery')return true;try{const rel=path.relative(path.join(home,'Downloads'),fs.realpathSync(candidate.appPath));return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}catch{return false;}};
  const normalizeName=value=>String(value||'').replace(/\.(?:app|exe)$/i,'').replace(/ 网页版$/,'').replace(/[\s._-]/g,'').toLowerCase();
  const app = (macPath, names, executables) => {
    const aliases=new Set([...names,path.basename(macPath||'')].map(normalizeName).filter(Boolean));
    const found=(Array.isArray(discoveredProviders)?discoveredProviders:[]).find(candidate=>candidate?.installed===true&&!downloadedApplication(candidate)&&typeof candidate.appPath==='string'&&path.isAbsolute(candidate.appPath)&&
      [candidate.name,path.basename(candidate.appPath)].some(name=>aliases.has(normalizeName(name))));
    return found?.appPath || (platform === 'darwin' ? macPath : platform === 'win32' ? winApp(names,executables) : null);
  };
  const envFor=id=>providerEnvironment(id,{environment:env,home,platform});
  const resourceRoot = appPath => appPath ? platform === 'darwin' ? path.join(appPath,'Contents','Resources') : path.join(path.dirname(appPath),'resources') : null;
  const installedApp = appPath => !!appPath && (platform === 'win32' ? exists(appPath) : appExists(appPath));
  const codexApplication=app('/Applications/ChatGPT.app',['Codex','ChatGPT'],['Codex.exe','ChatGPT.exe']);
  const codex = lookup('codex', [...(platform==='darwin'?[
    ...(codexApplication?[path.join(codexApplication,'Contents/Resources/codex'),path.join(codexApplication,'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')]:[]),
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex']:[]), path.join(home, '.local/bin/codex'),path.join(home,'.local/bin/codex.exe')]);
  const codexLogin = inspectCommand(codex, ['login', 'status'], envFor('codex'), nodePath);
  const codexReady = !!codexLogin && codexLogin.status === 0 && /Logged in/i.test(codexLogin.output);
  const codexModels = readCodexModels(home,env).map(model => ({ ...model, ready: codexReady, availability: codexReady ? 'configured' : 'needs-authentication' }));
  const claude = lookup('claude', [path.join(home, '.local/bin/claude'), path.join(home,'.local/bin/claude.exe'), ...(platform==='darwin'?['/opt/homebrew/bin/claude']:[])]);
  const claudeHelp = inspectCommand(claude, ['--help'], envFor('claude'), nodePath);
  const claudeCLI = !!claudeHelp && /--output-format/.test(claudeHelp.output) && /--print/.test(claudeHelp.output);
  const claudeAuth = claudeCLI ? inspectCommand(claude, ['auth', 'status', '--json'], envFor('claude'), nodePath) : null;
  let claudeReady = false,claudeAuthStatus='unknown';
  if (claudeAuth && claudeAuth.status === 0) {
    try { const status=JSON.parse(claudeAuth.output.trim());claudeReady=status.loggedIn===true;claudeAuthStatus=status.loggedIn===true?'configured':status.loggedIn===false?'required':'unknown'; } catch { /* unknown authentication is not ready */ }
  }
  const workbuddyApp = app('/Applications/WorkBuddy AI.app',['WorkBuddy AI','WorkBuddy'],['WorkBuddy AI.exe','WorkBuddy.exe']);
  const workbuddyResources = resourceRoot(workbuddyApp);
  const workbuddyCLI = workbuddyResources ? path.join(workbuddyResources,'app.asar.unpacked/cli/dist/codebuddy-headless.js') : '';
  const dshApp = app('/Applications/DeepSeek Harness.app',['DeepSeek Harness'],['DeepSeek Harness.exe']);
  const dshResources = resourceRoot(dshApp);
  const dshCLI = lookup('dsh',dshResources ? [path.join(dshResources,'runtime/cli/bin/dsh')] : []);
  const dshHome=typeof env.DSH_HOME==='string'&&path.isAbsolute(env.DSH_HOME)?env.DSH_HOME:path.join(home,'.dsh');
  const dshConfigured = exists(path.join(dshHome, '.credentials.yaml')) || !!env.DEEPSEEK_API_KEY;
  const dshMetadata = readDshConnectorMetadata({ home, dshApp, workbuddyApp, refreshModels, platform, environment:env });
  const dshExternalModels = dshMetadata.variants.flatMap(variant => (variant.models || []).filter(model => safeModelId(model.id)).map(model => ({
    ...model, id: `${variant.providerRoute}::${model.id}`, modelId: model.id, label: `${variant.label} · ${model.label}${variant.models.filter(other => other.label === model.label).length > 1 ? ` (${model.id})` : ''}`,
    providerRoute: variant.providerRoute, profile: 'headless', efforts: safeEfforts(model.efforts),
  })));
  const nativeDshModels = [{ id: 'deepseek-flash', label: 'DeepSeek-V41-Flash' }, { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' }].map(model => ({
    id: `deepseek-official::${model.id}`, modelId: model.id, label: `DeepSeek · ${model.label}`, providerRoute: 'deepseek-official', profile: 'headless',
    efforts: ['default', 'off', 'low', 'high', 'max'], ready: dshConfigured, availability: dshConfigured ? 'configured' : 'needs-authentication',
    source: { kind: 'dsh-bundled-catalog', profile: 'headless' },
  }));
  const dshModels = [{ id: 'default', label: '跟随 headless 配置', modelId: 'deepseek-flash', providerRoute: 'deepseek-official', profile: 'headless',
    efforts: ['default', 'off', 'low', 'high', 'max'], ready: dshConfigured, availability: dshConfigured ? 'configured' : 'needs-authentication',
    source: { kind: 'dsh-headless-default', profile: 'headless' } }, ...dshExternalModels, ...nativeDshModels];
  const workbuddyVariant = dshMetadata.variants.find(variant => variant.providerRoute === 'workbuddy-ai');
  const workbuddyModels = workbuddyVariant?.models || [];
  const workbuddyDesktopReady = !!workbuddyVariant?.ready && !!dshMetadata.connector && exists(workbuddyCLI);
  const codebuddyModels = (readJSON(path.join(home, '.codebuddy', 'models.json'))?.models || []).filter(model => safeModelId(model.id)).map(model => ({
    id: model.id, label: typeof model.name === 'string' ? model.name : model.id, efforts: ['default'], ready: false,
    availability: 'handoff-only', source: { kind: 'client-model-config', application: 'CodeBuddy CN' },
  }));
  const codebuddyApp = app('/Applications/CodeBuddy CN.app',['CodeBuddy CN','CodeBuddy'],['CodeBuddy CN.exe','CodeBuddy.exe']);
  const buddycn = lookup('buddycn', [path.join(home, '.codebuddy/bin/buddycn')]);
  const officialCodeBuddy = validatedCodeBuddyCLI(codebuddyCLIPath) || validatedCodeBuddyCLI(lookup('codebuddy'));
  const opencodeApp = app(platform==='darwin'?[path.join(home,'Applications','OpenCode.app'),'/Applications/OpenCode.app'].find(appExists)||path.join(home,'Applications','OpenCode.app'):'',['OpenCode'],['OpenCode.exe']);
  const opencodeResources = resourceRoot(opencodeApp);
  const opencode = lookup('opencode', opencodeResources ? [path.join(opencodeResources, platform === 'win32' ? 'opencode-cli.exe' : 'opencode-cli')] : []);
  const opencodeMetadata = readOpenCodeMetadata({ home, appPath: opencodeApp, executable: opencode, platform, env, nodePath });
  const claudeApp = app('/Applications/Claude.app',['Claude'],['Claude.exe']);
  const marvisApp = app('/Applications/Marvis.app',['Marvis'],['Marvis.exe']);
  const doubaoApp = app('/Applications/Doubao.app',['Doubao','豆包'],['Doubao.exe','豆包.exe']);
  const codexApp = codexApplication;
  const provider = (id, name, fields) => ({ id, name, installed: false, ready: false,
    mode: 'handoff', appPath: null, executable: null, models: [{ id: 'default', label: '跟随客户端', efforts: ['default'], ready: false, availability: 'client-managed', source: { kind: 'not-exposed' } }],
    efforts: ['default'], message: '', ...fields });
  const providers = [
    provider('codex', 'GPT / Codex', { installed: !!codex, ready: codexReady, mode: codex ? 'cli' : 'handoff',
      appPath: codexApp, executable: codex, authStatus:codexReady?'configured':/not logged in|authentication required/i.test(codexLogin?.output||'')?'required':'unknown',
      models: codexModels.length ? codexModels : [{ id: 'default', label: '跟随 Codex 配置', efforts: ['default'], ready: codexReady,
        availability: 'unknown-catalog', source: { kind: 'cli-config' } }],
      efforts: ['default', ...new Set(codexModels.flatMap(model => model.efforts))],
      message: codexReady ? '已验证 Codex 登录，可读取结构化事件与实际用量。' : codex ? 'CLI 已安装；请先在 Codex 登录。' : '未检测到 Codex CLI。' }),
    provider('claude', 'Claude', { installed: claudeCLI || installedApp(claudeApp),
      ready: claudeReady,authStatus:claudeAuthStatus, mode: claudeCLI ? 'cli' : 'handoff', appPath: claudeApp, executable: claudeCLI ? claude : null,
      models: [{ id: 'default', label: '跟随 Claude Code 配置', efforts: ['default'], ready: claudeReady,
        availability: claudeReady ? 'configured' : 'needs-authentication', source: { kind: 'cli-auth-status' } }],
      efforts: claudeCLI && /--effort/.test(claudeHelp.output) ? ['default', 'low', 'medium', 'high', ...(/\bxhigh\b/.test(claudeHelp.output)?['xhigh']:[]), 'max'] : ['default'],
      message: claudeReady ? 'Claude Code 已登录，支持结构化执行。' : claudeCLI ? 'Claude Code 已安装；认证尚未确认，请先在 CLI 登录。' : '已安装的 Claude 桌面端没有可调用的 Claude Code CLI；需要手动交接或安装并登录官方 CLI。' }),
    provider('workbuddy', 'WorkBuddy AI', { installed: installedApp(workbuddyApp), ready: workbuddyDesktopReady,
      mode: exists(workbuddyCLI) ? 'cli' : 'handoff', appPath: workbuddyApp,
      executable: exists(workbuddyCLI) ? workbuddyCLI : null, nodePath,
      ...(dshMetadata.connector ? { authBridge: { kind: 'workbuddy-desktop-credential', connector: dshMetadata.connector },
        origin: 'workbuddy-vendor-headless-with-desktop-credential' } : {}),
      models: [{ id: 'default', modelId: 'fast-model', label: 'WorkBuddy 快速模型', efforts: ['default'], ready: workbuddyDesktopReady,
        availability: workbuddyDesktopReady ? 'desktop-credential-configured' : 'needs-cli-authentication', source: { kind: 'cli-default-alias' } }, ...workbuddyModels.map(model => ({ ...model, modelId: model.id,
        efforts: safeEfforts(model.efforts.filter(effort => effort !== 'off')),
        ready: workbuddyDesktopReady && model.ready === true, availability: workbuddyDesktopReady && model.ready === true ? 'desktop-credential-configured' : 'needs-cli-authentication' }))],
      efforts: safeEfforts(workbuddyModels.flatMap(model => model.efforts || []).filter(effort => effort !== 'off')),
      authStatus:workbuddyDesktopReady?'configured':workbuddyVariant?.authStatus||'unknown',adapterStatus:exists(workbuddyCLI)&&dshMetadata.connector?'available':'unavailable',
      readinessReason:{code:workbuddyDesktopReady?'desktop-session-linked':!dshMetadata.connector?'credential-reader-unavailable':workbuddyVariant?.authStatus==='required'?'authentication-required':'connection-unverified',message:workbuddyDesktopReady?'已关联 WorkBuddy 现有登录。':!dshMetadata.connector?'已发现原应用；缺少可用的同厂商授权读取组件，不能据此判断你未登录。':'正在使用原有账号检测连接；失败时先重新检测，不需要重复登录。'},
      message: workbuddyDesktopReady ? '已自动关联 WorkBuddy 原有授权和模型目录。' : !exists(workbuddyCLI)?'未发现可调用的 WorkBuddy 执行入口。':!dshMetadata.connector?'原应用登录由 WorkBuddy 管理；当前缺少可用的授权连接组件。':'现有授权的连接尚未确认，请重新检测。' }),
    provider('codebuddy', 'CodeBuddy CN', { installed: installedApp(codebuddyApp) || !!officialCodeBuddy, appPath: codebuddyApp,
      mode: officialCodeBuddy ? 'cli' : 'handoff', executable: officialCodeBuddy?.executable || buddycn,
      ...(officialCodeBuddy ? { officialPackage: { name: officialCodeBuddy.packageName, version: officialCodeBuddy.packageVersion },
        origin: 'codebuddy-official-cli', authenticationState: 'unknown', nodePath,
        models: [{ id: 'default', label: '跟随 CodeBuddy CLI 账号配置', efforts: ['default'], ready: false,
          availability: 'needs-cli-verification', source: { kind: 'official-cli-default', packageVersion: officialCodeBuddy.packageVersion } }] }
        : codebuddyModels.length ? { models: codebuddyModels } : {}),
      message: officialCodeBuddy ? '官方 CodeBuddy Code 已安装；先完成 CLI 网页授权并验证。原 IDE 登录不等于此执行入口已登录，地区跟随官方 CLI 账号。' :
        '已读取客户端已配置模型；IDE CLI可打开agent聊天，但没有已验证的独立执行和完成回传接口，使用手动交接。' }),
    provider('dsh', 'DeepSeek Harness', { installed: installedApp(dshApp) || !!dshCLI, ready: exists(dshCLI) && (dshConfigured || dshExternalModels.some(model => model.ready)), mode: exists(dshCLI) ? 'cli' : 'handoff',
      executable: exists(dshCLI) ? dshCLI : null, appPath: dshApp,
      models: dshModels, efforts: safeEfforts(dshModels.flatMap(model => model.efforts)), messageCapture: 'final-only',
      ...(dshMetadata.connector ? { connector: dshMetadata.connector } : {}),
      message: dshExternalModels.length ? `已发现${dshExternalModels.length}个外接模型；每项标明来源与认证状态，执行按实际provider路由，独立headless运行。` : '已检测到headless；未读取到账号关联的外接目录时不猜测。真实认证以每次调用结果为准。' }),
    provider('marvis', '马维斯 / Marvis', { installed: installedApp(marvisApp),
      appPath: marvisApp, authStatus: 'client-managed', adapterStatus: 'unavailable',
      readinessReason: { code: 'adapter-unavailable', message: '原应用已安装，账号由马维斯管理；尚无已验证的公开执行和完成回传接口，不代表你没有登录。' },
      message: '原应用已安装，账号由马维斯管理；尚无已验证的公开执行和完成回传接口，可打开原应用使用。' }),
    provider('doubao', '豆包', { installed: installedApp(doubaoApp),
      appPath: doubaoApp, authStatus: 'client-managed', adapterStatus: 'unavailable',
      readinessReason: { code: 'adapter-unavailable', message: '原应用已安装，账号由豆包管理；工作台缺少公开任务执行和完成回传接口，不代表你没有登录。' }, models: [{ id: 'default', label: '跟随豆包客户端', efforts: ['default'], ready: false,
        availability: 'client-managed', source: { kind: 'not-exposed' } }],
      message: '豆包原客户端账号由应用管理；目前缺少经过验证的独立任务 CLI、完成事件或用量回传。可打开原应用使用，Token 和缓存显示未知。' }),
    provider('opencode', 'OpenCode', { installed: installedApp(opencodeApp) || !!opencode, appPath: opencodeApp, executable: opencode,
      cliAvailable: !!opencode, authStatus: opencodeMetadata.accountConfigured ? 'configured' : 'client-managed',
      adapterStatus: opencode ? 'available' : 'unavailable', serverContext: opencodeMetadata.serverContext || null,
      readinessReason: { code: opencodeMetadata.status === 'server-selection-unavailable' ? 'desktop-server-unavailable' :
        opencodeMetadata.freeClientOnly ? 'free-client-only' : 'execution-unverified',
        message: opencodeMetadata.status === 'server-selection-unavailable' ? '原客户端选择了另一个服务器；当前没有验证这个服务器的执行连接，不代表你没有登录。' :
          opencodeMetadata.freeClientOnly ? '原厂限制免费模型仅在原应用内使用；已读到模型目录，但外部执行请求被拒绝。原应用登录状态不等于此接口可执行。' :
          '原厂 CLI 已发现；仅在已认证的模型配置与执行终态通过验证后启用，原应用账号由 OpenCode 管理。' },
      message: opencodeMetadata.models.length ? `已从${opencodeMetadata.serverContext === 'desktop-selected-local-server' ? '原客户端服务器' : '共享后台服务'}读到${opencodeMetadata.models.length}个实际模型。${opencodeMetadata.freeClientOnly ? '免费目录不等于外部执行权限；原厂拒绝在原应用外使用免费模型。' : '模型目录与独立执行权限分开验证；当前执行连接尚未通过验证。'}` :
        '原应用账号由 OpenCode 管理；目前未取得可信的可执行模型目录，不能据此判断你没有登录。',
      models: opencodeMetadata.models.length ? opencodeMetadata.models.map(id => ({ id, label: id, efforts: ['default'], ready: false,
        availability: opencodeMetadata.freeClientOnly ? 'client-only' : 'execution-unverified', source: { kind: 'opencode-cli-model-list', context: opencodeMetadata.serverContext } })) :
        [{ id: 'default', label: '原应用管理模型', efforts: ['default'], ready: false, availability: 'execution-unverified', source: { kind: 'not-exposed' } }],
    }),
  ];
  providers.push(...googleAgents.detectGoogleProviders({home,platform,env,nodePath,applications:discoveredProviders}));
  for (const candidate of Array.isArray(discoveredProviders) ? discoveredProviders : []) {
    if (!candidate || !/^[a-z][a-z0-9-]{0,63}$/.test(candidate.id || '') || providers.some(item => item.id === candidate.id)) continue;
    if(candidate.appPath&&providers.some(item=>item.appPath&&(platform==='win32'?path.resolve(item.appPath).toLowerCase()===path.resolve(candidate.appPath).toLowerCase():path.resolve(item.appPath)===path.resolve(candidate.appPath))))continue;
    const appPath = typeof candidate.appPath === 'string' && path.isAbsolute(candidate.appPath) && (candidate.appPath.endsWith('.app') || platform === 'win32' && /\.exe$/i.test(candidate.appPath)) ? candidate.appPath : null;
    providers.push(provider(candidate.id, typeof candidate.name === 'string' ? candidate.name.slice(0, 120) : candidate.id, {
      ...candidate, installed: candidate.installed === true, appPath, mode:'handoff',ready:false,executable:null,models:[{id:'default',label:'跟随客户端',efforts:['default'],ready:false,availability:'client-managed',source:{kind:'not-exposed'}}],authStatus: 'client-managed', adapterStatus: 'unavailable',
      readinessReason: { code: 'adapter-unavailable', message: '已发现原应用，账号由原应用管理；工作台尚无经过验证的任务执行和结果接口。' },
      message: '已发现原应用，账号由原应用管理；工作台尚无经过验证的任务执行和结果接口。',
    }));
  }
  return providers;
}

const codeBuddyCatalogCache = new Map();
async function enrichCodeBuddyProvider(provider, { nodePath = process.execPath, inspect, refresh = false, home=os.homedir(), platform=process.platform, environment=process.env } = {}) {
  if (provider?.id !== 'codebuddy' || provider.mode !== 'cli' || !validatedCodeBuddyCLI(provider.executable)) return provider;
  const configuredRoot=typeof environment.CODEBUDDY_CONFIG_DIR==='string'&&path.isAbsolute(environment.CODEBUDDY_CONFIG_DIR)?environment.CODEBUDDY_CONFIG_DIR:null;
  const supportRoot=platform==='win32'?environment.LOCALAPPDATA||path.join(home,'AppData','Local'):path.join(home,'Library','Application Support');
  const authRoots=[supportRoot,...(platform==='win32'?[environment.APPDATA||path.join(home,'AppData','Roaming')]:[])].map(root=>path.join(root,'CodeBuddyExtension','Data','Public','auth'));
  let signature = '';
  signature=authRoots.map(authRoot=>{try{return fs.readdirSync(authRoot).filter(name=>name.includes('coding-copilot')&&(name.endsWith('.info')||name.endsWith('.logged-out'))).sort().slice(0,64).map(name=>{const stat=fs.statSync(path.join(authRoot,name));return `${name}:${stat.mtimeMs}/${stat.size}`;}).join(':');}catch{return 'absent';}}).join('|');
  const key = `${platform}:${home}:${configuredRoot}:${supportRoot}:${provider.executable}:${nodePath}:${signature}`;
  const cached = codeBuddyCatalogCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < 5000) return { ...provider, ...cached.fields };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-codebuddy-catalog-'));fs.chmodSync(directory, 0o700);
  try {
    const reader = inspect || require('./codebuddy-auth.cjs').inspectCodeBuddyCatalog;
    if (typeof reader !== 'function') return provider;
    const catalog = await reader({ cliPath: provider.executable, nodePath, cwd: directory, timeoutMs: 15000, env:providerEnvironment('codebuddy',{environment,home,platform}), platform });
    let fields;
    if (catalog?.authenticated === false) fields = { ready: false, authenticationState: 'required', authStatus:'required',
      models: provider.models.map(model => ({ ...model, ready: false, availability: 'needs-authentication' })),
      message: 'CodeBuddy 官方 CLI 尚未完成授权；请先点击网页登录。当前 IDE 的登录没有被当成 CLI 登录。' };
    else if (catalog?.authenticated === true) {
      const rows = (Array.isArray(catalog.models) ? catalog.models : []).filter(model => safeModelId(model?.id)).slice(0, 200);
      const models = rows.filter(model => model.id !== 'default').map(model => ({ id: model.id, modelId: model.id,
        label: typeof model.label === 'string' ? model.label.slice(0, 160) : model.id,
        efforts: safeEfforts((Array.isArray(model.efforts) ? model.efforts : []).filter(value => ['default','minimal','low','medium','high','xhigh','max'].includes(value))), ready: true, availability: 'configured-cli-account',
        source: { kind: 'codebuddy-acp-session', packageVersion: provider.officialPackage?.version } }));
      const current = models.find(model => model.id === catalog.defaultModelId);
      fields = { ready: models.length > 0, authenticationState: 'configured', authStatus:'configured', adapterStatus:'available',
        models: [{ id: 'default', ...(current ? { modelId: current.id } : {}), label: '跟随 CodeBuddy CLI 账号配置',
          efforts: current?.efforts || ['default'], ready: models.length > 0, availability: models.length ? 'configured-cli-account' : 'unknown-catalog',
          source: { kind: 'codebuddy-acp-session', packageVersion: provider.officialPackage?.version } }, ...models],
        efforts: safeEfforts(models.flatMap(model => model.efforts)),
        message: models.length ? `官方 CLI 已确认授权及${models.length}个目录模型；实际推理仍以每次成功终态为准。` : 'CLI 已确认授权，但暂未返回模型目录；可验证默认模型后使用。' };
    } else return provider;
    codeBuddyCatalogCache.set(key, { at: Date.now(), fields });
    if (codeBuddyCatalogCache.size > 8) codeBuddyCatalogCache.delete(codeBuddyCatalogCache.keys().next().value);
    return { ...provider, ...fields };
  } catch {
    return { ...provider, authenticationState: 'unknown', authStatus:'unknown', message: 'CodeBuddy 现有授权检测暂未完成，请重新检测。' };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function readOnlyStage(stage = {}) {
  return stage.probe === true || ['plan', 'review', 'acceptance', '验收', '规划'].includes(stage.role || stage.kind || stage.id);
}

function providerEnvironment(id,{environment=process.env,home,platform=process.platform}={}) {
  const common = new Set(['PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
    'TERM', 'COLORTERM', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'ComSpec', 'COMSPEC',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);
  const own = {
    codex: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
    claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'],
    workbuddy: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_BASE_URL'],
    codebuddy: ['CODEBUDDY_CONFIG_DIR'],
    opencode: ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','OPENCODE_DB','OPENCODE_CONFIG','OPENCODE_CONFIG_DIR'],
    gemini: ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_CLOUD_API_KEY','GEMINI_CLI_SYSTEM_SETTINGS_PATH','GEMINI_CLI_SYSTEM_DEFAULTS_PATH','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GOOGLE_GENAI_USE_VERTEXAI','GOOGLE_GENAI_USE_GCA','GEMINI_CLI_HOME'],
    antigravity:['AGY_ADC_AUTH','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GOOGLE_APPLICATION_CREDENTIALS'],
    dsh: ['DSH_HOME', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'WORKBUDDY_AUTH_FILE', 'WORKBUDDY_AI_AUTH_FILE',
      'WORKBUDDY_ELECTRON_BIN', 'WORKBUDDY_AI_ELECTRON_BIN'],
  };
  for (const key of own[id] || []) common.add(key);
  const env = Object.fromEntries(Object.entries(environment).filter(([key,value]) => typeof value==='string'&&!value.includes('\0')&&(common.has(key) || /^LC_[A-Z_]+$/.test(key))));
  if(home){env.HOME=home;if(platform==='win32')env.USERPROFILE=home;}
  if (id === 'codebuddy') {
    if (env.CODEBUDDY_CONFIG_DIR && (!path.isAbsolute(env.CODEBUDDY_CONFIG_DIR) || /[\u0000-\u001f]/.test(env.CODEBUDDY_CONFIG_DIR))) delete env.CODEBUDDY_CONFIG_DIR;
    env.DISABLE_AUTOUPDATER = '1';
    env.CODEBUDDY_DISABLE_PRODUCT_CACHE = '1';
    // The official CLI restores its own account region. Never import the IDE's
    // identity, a WorkBuddy credential, or ambient API/enterprise endpoints.
  }
  return env;
}

function resolveSelection(provider, stage) {
  const requested = stage.model || 'default';
  const options = Array.isArray(provider.models) ? provider.models : [];
  let selected = options.find(model => model.id === requested);
  if (provider.id === 'dsh' && !selected && ['deepseek-flash', 'deepseek-v4-pro'].includes(requested)) {
    selected = options.find(model => model.id === `deepseek-official::${requested}`) || {
      id: requested, modelId: requested, providerRoute: 'deepseek-official', profile: 'headless',
    };
  }
  if (provider.id === 'dsh' && requested !== 'default' && !selected) throw new Error('所选DSH模型不在当前已发现目录中，请刷新模型后重选。');
  if (provider.id === 'codebuddy' && requested !== 'default' && !selected) throw new Error('所选 CodeBuddy 模型尚未从已授权 CLI 目录确认。');
  const modelId = selected?.modelId || (requested === 'default' ? (provider.id === 'workbuddy' ? 'fast-model' : null) : requested);
  const providerRoute = provider.id === 'dsh' ? (selected?.providerRoute || 'deepseek-official') : undefined;
  if (provider.id === 'dsh' && !['deepseek-official', 'workbuddy', 'workbuddy-ai'].includes(providerRoute)) throw new Error('所选DSH路由尚未验证。');
  if (selected && stage.effort && stage.effort !== 'default' && Array.isArray(selected.efforts) && !selected.efforts.includes(stage.effort)) {
    throw new Error('所选模型没有声明或验证该思考强度，请选择跟随模型默认或已列出的档位。');
  }
  return { modelId, providerRoute, profile: provider.id === 'dsh' ? 'headless' : undefined, selected };
}

// Pure construction: prompt text is always stdin; model/effort values are argv.
function buildInvocation({ provider, stage = {}, prompt, workspace, nodePath = process.execPath, patchPath } = {}) {
  if (!provider || !['codex', 'claude', 'workbuddy', 'codebuddy', 'dsh','gemini','antigravity'].includes(provider.id)) throw new Error('此智能体需要手动交接。');
  if (!provider.executable || provider.mode !== 'cli') throw new Error('没有经过确认的 CLI 入口。');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('任务内容不能为空。');
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('工作区必须是绝对路径。');
  if(['gemini','antigravity'].includes(provider.id))return googleAgents.buildGoogleInvocation({provider,stage:{...stage,readOnly:readOnlyStage(stage)},prompt,workspace,nodePath,env:providerEnvironment(provider.id)});
  if (stage.probe === true) {
    if (provider.id === 'codex') throw new Error('Codex CLI 未提供已验证的全面禁用工具探针；请使用登录状态检测。');
    prompt = '只回复 OK，不要添加任何其他内容。此连接检测不允许使用任何工具。';
  }
  const selection = resolveSelection(provider, stage);
  const model = selection.modelId ? String(selection.modelId) : null;
  const effort = stage.effort && stage.effort !== 'default' ? String(stage.effort) : null;
  if (model && (model.length > 200 || model.startsWith('-') || /[\u0000-\u001f]/.test(model))) throw new Error('模型名称无效。');
  if (effort && !['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('思考强度无效。');
  const env = providerEnvironment(provider.id);
  let command = provider.executable;
  let args;
  if (provider.id === 'codex') {
    args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', workspace,
      '--sandbox', readOnlyStage(stage) ? 'read-only' : 'workspace-write',
      '-c', 'sandbox_workspace_write.network_access=false', '-c', 'approval_policy="never"'];
    if (model) args.push('--model', model);
    if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    args.push('-');
  } else if (provider.id === 'claude' || provider.id === 'workbuddy' || provider.id === 'codebuddy') {
    args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', readOnlyStage(stage) ? 'plan' : 'acceptEdits'];
    if (stage.probe === true) args.push('--tools', '', '--max-turns', '1', '--no-session-persistence',
      '--system-prompt', 'Reply only OK. Do not use any tools.', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"hooks":{},"enabledPlugins":{}}');
    else if (readOnlyStage(stage)) args.push('--tools', 'Read,Glob,Grep', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"hooks":{},"enabledPlugins":{}}');
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (provider.id === 'workbuddy' || provider.id === 'codebuddy') {
      command = nodePath;
      args.unshift(provider.executable);
      if (provider.id === 'codebuddy' && !args.includes('--setting-sources')) args.push('--setting-sources', 'none', '--settings', '{"hooks":{},"enabledPlugins":{}}');
      const settingsIndex = args.indexOf('--setting-sources');
      if (settingsIndex !== -1) args[settingsIndex + 1] = 'none';
      env.ELECTRON_RUN_AS_NODE = '1';
      env.CODEBUDDY_DISABLE_COMPILE_CACHE = '1';
    }
  } else {
    args = ['--profile', 'headless'];
    env.DSH_PERMISSION_MODE = readOnlyStage(stage) ? 'read-only' : 'workspace-write';
    if (patchPath || model || effort || stage.probe === true) {
      if (!patchPath) throw new Error('DSH 模型切换需要独立的临时 profile patch。');
      args.push('--patch', patchPath);
    }
    args.push('--json', '-');
  }
  const invocation = resolveCLIInvocation({executable:command,args,env,nodePath});
  return { ...invocation, stdin: prompt, cwd: workspace, protocol: provider.id, selection };
}

function cleanError(text) {
  return String(text).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
    .slice(-3000);
}

function publicToolActivity(block) {
  const name = typeof block.name === 'string' ? cleanError(block.name).slice(0, 100) : '工具调用';
  const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {};
  let detail = '';
  if (['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(name)) {
    detail = ['file_path', 'path', 'pattern'].filter(key => typeof input[key] === 'string')
      .map(key => `${key}: ${cleanError(input[key]).replace(/https?:\/\/\S+/gi, '[URL 已隐藏]').replace(/[\r\n\t]/g, ' ').slice(0, 200)}`).join(' · ');
  } else if (name === 'Bash' && typeof input.command === 'string') {
    // A command may contain headers or credentials. Only a redacted summary is
    // public; arbitrary input fields and full network addresses never leave here.
    const sensitive = /(?:^|\s)(?:-H|--header)(?:\s|=)|\b(?:[A-Za-z0-9_]*(?:token|password|secret|api[_-]?key)|authorization)\s*[:=]/i.test(input.command);
    detail = sensitive ? '包含凭据或请求头的命令（内容已隐藏）' :
      cleanError(input.command).replace(/https?:\/\/\S+/gi, '[URL 已隐藏]').replace(/[\r\n\t]/g, ' ').slice(0, 700);
  }
  return detail ? `${name} · ${detail}` : name;
}

function usageFrom(raw, type) {
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const cacheRead = firstNumber(raw.cached_input_tokens, raw.cache_read_input_tokens, raw.cacheRead, raw.cacheTokens, raw.cacheReadTokens,
    raw.input_tokens_details?.cached_tokens, raw.prompt_tokens_details?.cached_tokens);
  const cacheWrite = firstNumber(raw.cache_creation_input_tokens, raw.cacheWrite, raw.cachedWriteTokens, raw.cacheWriteTokens);
  let input = firstNumber(raw.input_tokens, raw.inputTokens, raw.prompt_tokens);
  // Anthropic's input_tokens excludes its explicitly separate cache buckets.
  if (type === 'claude' && input !== null) input = cacheRead !== null && cacheWrite !== null ? input + cacheRead + cacheWrite : null;
  return { input, output: firstNumber(raw.output_tokens, raw.outputTokens, raw.completion_tokens), cacheRead, cacheWrite,
    reasoning: firstNumber(raw.reasoning_tokens, raw.reasoningTokens, raw.output_tokens_details?.reasoning_tokens, raw.completion_tokens_details?.reasoning_tokens), costUSD: null };
}

async function runProvider({ provider, stage = {}, prompt, workspace, onEvent = () => {}, signal, nodePath = process.execPath } = {}) {
  if (signal?.aborted) throw new Error('任务已取消。');
  let patchDirectory = null;
  let patchPath;
  let managedDshHome = null,invocation;
  try {
    const selection = provider?.id === 'dsh' ? resolveSelection(provider, stage) : null;
    const externalRoute = selection && ['workbuddy', 'workbuddy-ai'].includes(selection.providerRoute);
    if (provider?.id === 'dsh') {
      patchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-dsh-'));
      fs.chmodSync(patchDirectory, 0o700);
      patchPath = path.join(patchDirectory, 'selection.yml');
      // Loader patches replace a row's entire config, so preserve required defaults.
      const config = { provider: selection.providerRoute, model: selection.modelId || 'deepseek-flash' };
      if (stage.effort && stage.effort !== 'default') config.reasoningEffort = String(stage.effort);
      const patches = [{ id: 'agent-default-model', config }];
      if (externalRoute) {
        if (!provider.connector || !exists(provider.connector.entry)) throw new Error('外接模型的既有connector不可用，请刷新检测；没有回退到其他模型。');
        const wrapperPath = path.join(patchDirectory, 'workbuddy-wrapper.mjs');
        fs.writeFileSync(wrapperPath, dshImportPrelude(provider.connector.runtimeRoot) +
          `const connector = await import(${JSON.stringify(pathToFileURL(provider.connector.entry).href)});\n` +
          `export const name = 'agentflow-workbuddy-wrapper';\nexport const inject = connector.inject;\nexport const Config = connector.Config;\n` +
          `export async function apply(ctx, config) {\n` +
          ` connector.apply(ctx, config);\n` +
          ` for(let attempt=0;attempt<150;attempt++){ try{ const models=await ctx.llm.listModels(${JSON.stringify(selection.providerRoute)});\n` +
          `  if(models.some(model=>model.id===${JSON.stringify(selection.modelId)})) return; }catch{}\n` +
          `  await new Promise(resolve=>setTimeout(resolve,100));\n` +
          ` } throw new Error('所选外接模型在当前账号目录中未就绪；没有回退到其他模型。');\n}\n`, { mode: 0o600 });
        patches.push({ insert: [{ id: 'agentflow-workbuddy', name: wrapperPath }] });
        managedDshHome = path.join(patchDirectory, 'home');
        fs.mkdirSync(managedDshHome, { mode: 0o700 });
        // Exact original DSH home is recorded by detection; never infer an auth path.
        const originalDshHome = provider.connector.dshHome || path.join(os.homedir(), '.dsh');
        for (const name of ['.workbuddy-ai-catalog.json', '.workbuddy-catalog.json', '.workbuddy-ai-probe.json', '.workbuddy-probe.json']) {
          const source = path.join(originalDshHome, name);
          if (exists(source) && fs.statSync(source).size <= 4 * 1024 * 1024) fs.copyFileSync(source, path.join(managedDshHome, name));
        }
        const originalSessions = path.join(originalDshHome, 'sessions');
        if (appExists(originalSessions)) fs.symlinkSync(originalSessions, path.join(managedDshHome, 'sessions'), process.platform==='win32'?'junction':'dir');
      }
      if (stage.probe === true) {
        const guardPath = path.join(patchDirectory, 'probe-guard.mjs');
        fs.writeFileSync(guardPath, [
          'export const name = "agentflow-probe-guard";',
          'export const inject = ["tools", "agents"];',
          'export function apply(ctx) {',
          '  ctx.tools.guard(() => "AgentFlow connection probes do not allow tool execution.");',
          '  ctx.on("agent/created", ({ agent }) => {',
          '    agent.ctx.tools.presentAs("native");',
          '    agent.ctx.tools.restrict({ allow: [] });',
          '  });',
          '}',
        ].join('\n'), { mode: 0o600 });
        patches.push({ insert: [{ id: 'agentflow-probe-guard', name: guardPath }] });
      }
      // JSON is valid YAML; composition applies to this process only.
      fs.writeFileSync(patchPath, JSON.stringify(patches), { mode: 0o600 });
    }
    invocation = buildInvocation({ provider, stage, prompt, workspace, nodePath, patchPath });
    if (provider.id === 'workbuddy' && provider.authBridge) {
      patchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-vendor-auth-'));
      fs.chmodSync(patchDirectory, 0o700);
      invocation = prepareVendorInvocation({ provider, invocation, directory: patchDirectory });
    }
    if (managedDshHome) {
      invocation.env.DSH_HOME = managedDshHome;
      const workbuddyApp=provider.connector?.workbuddyAppPath;
      const workbuddyElectron=workbuddyApp?(process.platform==='darwin'?path.join(workbuddyApp,'Contents/MacOS/Electron'):workbuddyApp):null;
      if (exists(workbuddyElectron)) invocation.env.WORKBUDDY_AI_ELECTRON_BIN = workbuddyElectron;
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env,
        shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let outputBytes = 0, buffer = '', stderr = '', text = '', sessionId, actualModelId;
      let terminal = false, terminalSuccess = false, outcomeError = '', diagnosticError = '', done = false, stopping = false, dshTurnCompleted = false;
      const dshSteps = new Map();
      let lastUsage = emptyUsage();
      const publicMessages = new Map();let lastPublicMessageId;
      const publicMessage = (id, value, final = true) => {
        if (typeof value !== 'string' || !value.trim() || typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(id)) return;
        const previous = publicMessages.get(id);
        if (previous?.text === value && previous.final === final) return;
        publicMessages.set(id, { text: value, final });lastPublicMessageId = id;
        emit({ type: 'message', role: 'assistant', id, text: value, final,
          messageCapture: provider.id === 'dsh' ? 'final-only' : 'public-messages' });
      };
      const decoder = new StringDecoder('utf8');
      const emit = event => { try { onEvent(event); } catch { /* consumer cannot break process cleanup */ } };
      let killTimer;
      const kill = () => {
        if (stopping) return;
        stopping = true;
        void terminateProcessTree(child);
        killTimer = setTimeout(() => { void terminateProcessTree(child,{force:true}); }, 1500);
        killTimer.unref();
      };
      const abort = () => { outcomeError = '任务已取消。'; kill(); };
      const timeout = setTimeout(() => { outcomeError = '此环节超过 30 分钟，已停止。'; kill(); }, TIMEOUT);
      timeout.unref();
      signal?.addEventListener('abort', abort, { once: true });
      const fail = message => { if (!outcomeError) outcomeError = message; kill(); };
      const setUsage = value => { lastUsage = value; emit({ type: 'usage', usage: value }); };
      const setSession = value => { if (typeof value === 'string' && value.length <= 1000) { sessionId = value; emit({ type: 'session', sessionId }); } };
      const setText = (value, final = false) => {
        if (typeof value !== 'string') return;
        text = value;
        emit({ type: 'text', text: value, final, replace: true });
      };
      const event = value => {
        if (!value || typeof value !== 'object') return;
        if(['gemini','antigravity'].includes(provider.id)){
          const parsed=googleAgents.parseGoogleEvent(value,provider.id);
          if(parsed.sessionId)setSession(parsed.sessionId);
          if(safeModelId(parsed.modelId))actualModelId=parsed.modelId;
          if(typeof parsed.text==='string'){
            setText(parsed.appendText?text+parsed.text:parsed.text,parsed.terminal===true);
            if(parsed.terminal||!parsed.appendText)publicMessage(parsed.messageId||'google-assistant',text,parsed.terminal===true);
          }
          if(parsed.usage)setUsage({...emptyUsage(),...parsed.usage});
          if(parsed.activity)emit({type:'activity',activity:'tool_call',text:cleanError(parsed.activity)});
          if(parsed.error)outcomeError=cleanError(parsed.error);
          if(parsed.terminal){terminal=true;terminalSuccess=parsed.success===true;if(text)publicMessage('google-assistant',text,true);}
        } else if (provider.id === 'codex') {
          if (value.type === 'thread.started') setSession(value.thread_id);
          else if (value.type === 'turn.completed') { terminal = true; terminalSuccess = true; setUsage(usageFrom(value.usage, 'codex')); }
          else if (value.type === 'error') {
            diagnosticError = cleanError(value.error?.message || value.message || 'Codex 客户端诊断');
            emit({ type: 'activity', activity: 'diagnostic', level: 'warning', message: diagnosticError, text: diagnosticError });
          }
          else if (value.type === 'turn.failed') {
            terminal = true; terminalSuccess = false;
            outcomeError = cleanError(value.error?.message || value.message || 'Codex 执行失败。');
          } else if (value.item) {
            const item = value.item;
            if (item.type === 'agent_message' && typeof item.text === 'string') {
              setText(item.text, value.type === 'item.completed');
              if (value.type === 'item.completed') publicMessage(item.id || 'codex-final', item.text);
            }
            else if (value.type === 'item.started' || value.type === 'item.completed') {
              const action = item.type === 'error' ? `Codex 客户端诊断：${String(item.message || item.error?.message || '未提供具体原因').slice(0,700)}`
                : item.type === 'command_execution' ? `执行命令：${String(item.command || '本地命令').slice(0,700)}`
                : item.type === 'file_change' ? `修改文件：${(item.changes || []).slice(0,8).map(c=>String(c.path || c.kind || '')).join('、')}`
                : item.type === 'mcp_tool_call' ? `调用工具：${item.server || ''}/${item.tool || ''}` : item.type || value.type;
              emit({type:'activity',activity:item.type==='error'?'diagnostic':item.type||value.type,level:item.type==='error'?'warning':'info',status:item.status||value.type,message:cleanError(action),text:cleanError(action)});
            }
          }
        } else if (provider.id === 'claude' || provider.id === 'workbuddy' || provider.id === 'codebuddy') {
          if (safeModelId(value.message?.model || value.model)) actualModelId = value.message?.model || value.model;
          if (value.type === 'system' && value.subtype === 'init') setSession(value.session_id);
          else if (value.type === 'result') {
            terminal = true; terminalSuccess = value.subtype === 'success' && value.is_error !== true;
            if (!terminalSuccess) outcomeError = cleanError(value.errors?.join('\n') || value.result || '智能体返回失败。');
            else {
              const finalText=value.result||text;setText(finalText,true);
              if(publicMessages.get(lastPublicMessageId)?.text!==finalText)publicMessage('assistant-final',finalText);
            }
            // This is one run's final aggregate. Never add it to streamed message usage.
            const resultUsage = usageFrom(value.usage, provider.id);
            if (provider.id === 'claude') resultUsage.costUSD = nonnegative(value.total_cost_usd);
            // WorkBuddy's bundled formatter hardcodes total_cost_usd: 0; it is not a bill.
            setUsage(resultUsage);
          } else if (value.type === 'assistant') {
            const blocks = value.message?.content || [];
            const visible = blocks.filter(block => block.type === 'text').map(block => block.text || '').join('');
            if (visible) { setText(visible);if (typeof value.message?.id === 'string') publicMessage(value.message.id, visible); }
            for (const block of blocks) if (block.type === 'tool_use') emit({ type: 'activity', activity: 'tool_call', text: publicToolActivity(block) });
          } else if (value.type === 'tool_result') emit({ type: 'activity', activity: 'tool_result', text: '工具返回' });
        } else if (provider.id === 'dsh') {
          if (value.type === 'session') setSession(value.sessionId || value.session_id || value.id);
          else if (value.type === 'final') { terminal = true; terminalSuccess = dshTurnCompleted; setText(value.text || value.answer || '', true);publicMessage('dsh-final', value.text || value.answer || ''); }
          else if (value.type === 'error') { terminal = true; terminalSuccess = false; outcomeError = cleanError(value.message || 'DSH 执行失败。'); }
          else if (value.type === 'text') setText(typeof value.text === 'string' ? value.text : '');
          else if (['status', 'tool_call', 'tool_result'].includes(value.type)) {
            if (value.type === 'status' && value.phase === 'turn_end') {
              dshTurnCompleted = value.reason?.kind === 'completed';
              if (!dshTurnCompleted) outcomeError = cleanError(value.reason?.error?.message || 'DSH 轮次未成功完成。');
            }
            if (value.type === 'status' && value.phase === 'step_end') {
              dshSteps.set(JSON.stringify([value.turn, value.step]), usageFrom(value.usage, 'dsh'));
              const values = [...dshSteps.values()];
              // Each step is a distinct subtotal. Missing buckets poison the full subtotal.
              const usage = emptyUsage();
              for (const key of USAGE_KEYS) {
                if (values.every(sample => sample[key] !== null)) usage[key] = values.reduce((sum, sample) => sum + sample[key], 0);
              }
              setUsage(usage);
            }
            emit({ type: 'activity', activity: value.type, status: value.status || value.phase,
              text: cleanError(value.name || value.tool || value.toolName || value.status || value.phase || value.type).slice(0, 1000) });
          }
        }
      };
      const line = input => {
        if (Buffer.byteLength(input, 'utf8') > MAX_LINE) { fail('智能体事件超过 1 MiB，已停止。'); return; }
        if (!input.trim()) return;
        try { event(JSON.parse(input)); } catch { emit({ type: 'activity', activity: 'diagnostic', text: cleanError(input).slice(0, 1000) }); }
      };
      const consume = chunk => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT) { fail('智能体输出超过 16 MiB，已停止。'); return; }
        buffer += decoder.write(chunk);
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) { const item = buffer.slice(0, index); buffer = buffer.slice(index + 1); line(item); }
        if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE) fail('智能体事件超过 1 MiB，已停止。');
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT) fail('智能体输出超过 16 MiB，已停止。');
        stderr = (stderr + chunk.toString('utf8')).slice(-6000);
      });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(cleanError(error.message)); });
      child.once('error', error => { outcomeError = cleanError(error.message); });
      child.once('close', (code, processSignal) => {
        if (done) return;
        done = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
        // Keep a scheduled group SIGKILL after cancellation: descendants can outlive the leader.
        if (!outcomeError && killTimer) clearTimeout(killTimer);
        buffer += decoder.end(); if (buffer) line(buffer);
        if (outcomeError || code !== 0 || processSignal || !terminal || !terminalSuccess) {
          kill(); // Failed leaders must not leave descendants or credential-bearing helpers alive.
          reject(new Error(outcomeError || (!terminalSuccess && diagnosticError) || cleanError(stderr) || (code !== 0 ? `智能体退出码 ${code ?? processSignal}。` : '智能体退出时没有可确认的成功终态。')));
        } else resolve({ text, usage: lastUsage, ...(sessionId ? { sessionId } : {}),
          ...(actualModelId ? { modelId: actualModelId } : {}), ...(invocation.origin || provider.origin ? { origin: invocation.origin || provider.origin } : {}) });
      });
      child.stdin.end(invocation.stdin);
      if (signal?.aborted) abort();
    });
  } finally {
    try{await invocation?.cleanup?.();}finally{if (patchDirectory) fs.rmSync(patchDirectory, { recursive: true, force: true });}
  }
}

async function probeProvider({ provider, stage = {}, onEvent, signal, nodePath = process.execPath } = {}) {
  if (!provider || !['claude', 'workbuddy', 'codebuddy', 'dsh','gemini'].includes(provider.id) || provider.mode !== 'cli' || provider.id==='gemini'&&provider.capabilities?.probe!==true) {
    throw new Error('此后端没有已验证的禁工具连接检测；Codex 可直接检查登录状态，桌面应用请使用交接。');
  }
  // Never use or delete a caller's directory. This function owns this exact path.
  const probeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-probe-'));
  fs.chmodSync(probeDirectory, 0o700);
  const controller = new AbortController();
  let timedOut = false, attemptedTool = false;
  const abort = () => controller.abort();
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
  deadline.unref();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const legalEfforts = provider.id === 'dsh' ? ['off', 'none', 'minimal', 'low', 'default'] : ['minimal', 'low', 'default'];
    let probeModel = stage.model || 'default';
    if (!stage.model && !stage.effort) {
      // Only connection checks may select a cheaper configured model. Never
      // substitute a model or effort explicitly selected for a task/probe.
      const candidates = (provider.models || []).filter(model => model.ready === true);
      const cheapest = legalEfforts.filter(effort => effort !== 'default').map(effort =>
        candidates.find(model => model.efforts?.includes(effort))).find(Boolean);
      if (cheapest) probeModel = cheapest.id;
    }
    const selectedEfforts = provider.models?.find(model => model.id === probeModel)?.efforts || [];
    // A connection probe should not inherit an expensive default reasoning
    // level when the model explicitly declares a cheaper supported option.
    // An explicit caller choice still wins; normal task stages are untouched.
    const probeEffort = legalEfforts.find(effort => selectedEfforts.includes(effort)) || 'default';
    const probeStage = { ...stage, id: 'probe', role: 'plan', probe: true, model: probeModel,
      effort: stage.effort || probeEffort };
    const result = await runProvider({ provider, stage: probeStage,
    prompt: 'OK', workspace: probeDirectory, signal: controller.signal, nodePath,
    onEvent: event => {
      if (event.type === 'activity' && event.activity === 'tool_call') attemptedTool = true;
      if (onEvent) onEvent(event);
    } });
    if (attemptedTool) throw new Error('连接检测收到工具调用事件，未通过禁工具检查。');
    if (result.text.trim() !== 'OK') throw new Error('连接检测未返回约定的 OK，请查看客户端状态。');
    return { ...result, verifiedModelId: probeStage.model, verifiedRequestModelId: result.modelId || resolveSelection(provider, probeStage).modelId,
      verifiedEffort: probeStage.effort };
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error('连接检测超过 60 秒，已停止；尚未收到成功终态，可能仍在生成。账号授权与推理完成会分别验证。');
      timeoutError.code = 'PROBE_TIMEOUT';throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    fs.rmSync(probeDirectory, { recursive: true, force: true });
  }
}

// A successful minimal probe proves this exact model on this executable for a
// bounded time. It never makes an untested catalog or another account ready.
function applyProviderVerification(provider, verification, now = Date.now()) {
  if (!provider || provider.mode !== 'cli' || !verification || verification.executable !== provider.executable
      || !Number.isFinite(verification.at) || now < verification.at || now - verification.at >= 3600000
      || !safeModelId(verification.modelId) || provider.id==='gemini'&&(provider.capabilities?.probe!==true||verification.providerVersion!==provider.version) || provider.authStatus==='required' || provider.authenticationState === 'required') return provider;
  const selected = provider.models?.find(model => model.id === verification.modelId);
  if (!selected) return provider;
  const verifiedAt = new Date(verification.at).toISOString();
  const observed=provider.id==='gemini'&&safeModelId(verification.actualModelId)&&!provider.models.some(model=>model.id===verification.actualModelId)?[{id:verification.actualModelId,label:verification.actualModelId,ready:true,efforts:['default'],availability:'verified',lastVerifiedAt:verifiedAt,source:{kind:'minimal-cli-probe',verification:'minimal-cli-probe'}}]:[];
  return { ...provider, ready: true, lastVerifiedAt: verifiedAt,
    message: '当前会话已通过所选模型的最小调用验证；每次任务仍检查最终结果。',
    models: [...provider.models.map(model => model.id === selected.id ? { ...model, ready: true, availability: 'verified',
      lastVerifiedAt: verifiedAt, source: { ...model.source, verification: 'minimal-cli-probe' } } : model),...observed] };
}

module.exports = { detectProviders, buildInvocation, runProvider, probeProvider, applyProviderVerification, enrichCodeBuddyProvider };

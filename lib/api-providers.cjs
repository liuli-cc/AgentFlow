'use strict';

// References: developers.openai.com/api/reference/resources/{chat,responses};
// platform.claude.com/docs/en/api/messages/create and /build-with-claude/effort.
// Only the configured endpoint receives requests. No SDK, telemetry or command tool.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PROTOCOLS = new Set(['openai', 'responses', 'anthropic']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_REQUEST = 8 * 1024 * 1024;
const MAX_ROUNDS = 12;
const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
const emptyUsage = () => ({ input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, costUSD: null, source: 'api' });
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const canceled = () => new Error('任务已取消。');
function checkAbort(signal) { if (signal?.aborted) throw canceled(); }
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(canceled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(canceled());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function textField(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label}无效。`);
  return value.trim();
}
function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) fail('API 地址无效。');
  let url;
  try { url = new URL(value); } catch { fail('API 地址无效。'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) fail('API 地址必须使用 HTTPS 或本机 HTTP，且不得包含账号、查询或片段。');
  return url.href.replace(/\/+$/, '');
}
function modelsFrom(values, source = 'manual', ready = false) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 1000) fail('模型列表无效。');
  const seen = new Set();
  return values.map(value => {
    const id = textField(typeof value === 'string' ? value : value?.id, '模型名称');
    if (seen.has(id)) return null;
    seen.add(id);
    const label = typeof value?.label === 'string' ? textField(value.label, '模型显示名称') : id;
    const efforts = Array.isArray(value?.efforts) ? [...new Set(value.efforts.filter(e => EFFORTS.has(e)))]: [];
    return { id, label, efforts, ready, source };
  }).filter(Boolean);
}
function readOnly(stage) { return stage.probe === true || ['plan', 'review', 'acceptance', '规划', '验收'].includes(stage.role || stage.kind || stage.id); }
function usageFrom(raw, protocol) {
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const out = emptyUsage();
  if (protocol === 'anthropic') {
    out.cacheRead = number(raw.cache_read_input_tokens);
    out.cacheWrite = number(raw.cache_creation_input_tokens);
    // Anthropic reports uncached input separately; cache is a subset in our UI.
    const uncached = number(raw.input_tokens);
    out.input = uncached === null ? null : uncached + (out.cacheRead ?? 0) + (out.cacheWrite ?? 0);
    out.output = number(raw.output_tokens);
    out.reasoning = number(raw.output_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens);
  } else {
    out.input = number(raw.input_tokens ?? raw.prompt_tokens);
    out.output = number(raw.output_tokens ?? raw.completion_tokens);
    const details = raw.input_tokens_details || raw.prompt_tokens_details || {};
    out.cacheRead = number(details.cached_tokens ?? raw.cache_read_input_tokens);
    out.cacheWrite = number(details.cache_write_tokens ?? raw.cache_creation_input_tokens);
    out.reasoning = number(raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens);
  }
  if (out.input !== null && out.cacheRead !== null) out.cacheRead = Math.min(out.input, out.cacheRead);
  if (out.input !== null && out.cacheWrite !== null) out.cacheWrite = Math.min(out.input - (out.cacheRead || 0), out.cacheWrite);
  if (out.output !== null && out.reasoning !== null) out.reasoning = Math.min(out.output, out.reasoning);
  return out;
}
function addUsage(total, current, first) {
  for (const key of USAGE_KEYS) total[key] = first ? current[key] : total[key] === null || current[key] === null ? null : total[key] + current[key];
  return total;
}
const toolSpecs = readonly => [
  { name: 'list_files', description: 'List a directory inside the task workspace. Symlinks are excluded.', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'read_file', description: 'Read a UTF-8 file inside the task workspace, up to 1 MiB.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  ...readonly ? [] : [{ name: 'write_file', description: 'Create or replace a UTF-8 workspace file, up to 1 MiB. No command execution.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } }],
];

// All path components are checked; writes use an exclusive temporary inode and
// rename rather than following an existing file or hard link.
async function workspaceTools(workspace, readonly, signal) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) fail('工作区必须是绝对路径。');
  const root = await fsp.realpath(workspace);
  if (!(await fsp.stat(root)).isDirectory()) fail('工作区无效。');
  const inside = file => file === root || file.startsWith(root + path.sep);
  async function target(relative, createParents = false) {
    if (typeof relative !== 'string' || relative.length > 4096 || /[\u0000-\u001f]/.test(relative) || path.isAbsolute(relative)) fail('文件路径必须位于工作区内。');
    const resolved = path.resolve(root, relative || '.');
    if (!inside(resolved)) fail('文件路径超出工作区。');
    const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      checkAbort(signal);
      current = path.join(current, parts[i]);
      try {
        const info = await fsp.lstat(current);
        if (info.isSymbolicLink()) fail('不允许访问符号链接。');
        if (i < parts.length - 1 && !info.isDirectory()) fail('父路径不是目录。');
        if (!inside(await fsp.realpath(current))) fail('文件路径超出工作区。');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (i < parts.length - 1 && createParents) {
          await fsp.mkdir(current, { mode: 0o700 });
          if (!inside(await fsp.realpath(current)) || (await fsp.lstat(current)).isSymbolicLink()) fail('父路径超出工作区。');
        } else if (i < parts.length - 1) fail('目录不存在。');
      }
    }
    return resolved;
  }
  return async (name, args) => {
    checkAbort(signal);
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('工具参数无效。');
    if (name === 'list_files') {
      const directory = await target(args.path ?? '.');
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      return JSON.stringify({ entries: entries.filter(entry => !entry.isSymbolicLink()).slice(0, 400).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > 400 });
    }
    if (name === 'read_file') {
      const file = await target(args.path);
      const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_FILE) fail('文件不是普通文件或超过 1 MiB。');
        const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_FILE + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_FILE || bytesRead > info.size) fail('文件读取超出限制。');
        checkAbort(signal);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
    }
    if (name === 'write_file') {
      if (readonly) fail('此环节只允许读取文件。');
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE) fail('文件内容超过限制。');
      const file = await target(args.path, true);
      if (file === root) fail('不能覆盖工作区目录。');
      const parent = path.dirname(file);
      const before = await fsp.realpath(parent);
      if (!inside(before)) fail('父路径超出工作区。');
      const temporary = path.join(parent, `.agentflow-${randomUUID()}.tmp`);
      try {
        await fsp.writeFile(temporary, args.content, { flag: 'wx', mode: 0o600, signal });
        checkAbort(signal);
        await target(args.path, false);
        if (await fsp.realpath(parent) !== before) fail('目录已变更，请重试。');
        await fsp.rename(temporary, file);
      } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
      return JSON.stringify({ path: path.relative(root, file), bytes: Buffer.byteLength(args.content), written: true });
    }
    fail('不支持此工具。');
  };
}

class ApiRegistry {
  constructor({ dataDir, vault, fetchImpl = global.fetch, onChange = () => {}, timeoutMs = 120000 } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) fail('API 配置目录必须是绝对路径。');
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'api-providers.json');
    this.vault = vault;
    this.fetchImpl = fetchImpl;
    this.onChange = onChange;
    this.timeoutMs = Math.max(50, Math.min(Number(timeoutMs) || 120000, 30 * 60 * 1000));
    this.records = new Map();
    this.persistQueue = Promise.resolve();
  }
  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const info = await fsp.lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RESPONSE) fail('API 配置文件无效。');
      const value = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.providers) || value.providers.length > 100) fail('API 配置格式无效。');
      for (const record of value.providers) {
        if (!/^api-[a-f0-9-]{36}$/.test(record.id) || !PROTOCOLS.has(record.protocol)) continue;
        const models = modelsFrom(record.models, 'manual');
        for (const model of models) {
          const previous = record.models.find(item => item.id === model.id);
          model.ready = previous.ready === true;
          model.source = ['manual', 'models', 'probe'].includes(previous.source) ? previous.source : 'manual';
        }
        this.records.set(record.id, { id: record.id, name: textField(record.name, 'API 名称', 100), baseUrl: normalizeBaseUrl(record.baseUrl), protocol: record.protocol,
          models, ready: record.ready === true && models.some(model => model.ready), ciphertext: typeof record.ciphertext === 'string' ? record.ciphertext : null,
          status: record.ready === true ? 'verified' : 'unverified', error: null });
      }
      await fsp.chmod(this.file, 0o600);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('API 配置无法读取，请检查配置文件。'); }
    return this.getProviders();
  }
  _metadata(record) {
    return { id: record.id, name: record.name, baseUrl: record.baseUrl, protocol: record.protocol, mode: 'api', installed: true,
      ready: record.ready === true, models: clone(record.models), efforts: ['default', ...new Set(record.models.flatMap(model => model.efforts))],
      hasKey: !!record.ciphertext, status: record.status, error: record.error || null };
  }
  getProviders() { return [...this.records.values()].map(record => this._metadata(record)); }
  _get(id) { const record = this.records.get(typeof id === 'object' ? id?.id : id); if (!record) fail('API 连接不存在。'); return record; }
  async _persist() {
    const snapshot = JSON.stringify({ version: 1, providers: [...this.records.values()] });
    const write = async () => {
      const temporary = path.join(this.dataDir, `.api-${randomUUID()}.tmp`);
      try { await fsp.writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' }); await fsp.rename(temporary, this.file); await fsp.chmod(this.file, 0o600); }
      finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
    };
    this.persistQueue = this.persistQueue.catch(() => {}).then(write);
    await this.persistQueue;
    try { this.onChange(this.getProviders()); } catch { /* UI callbacks cannot compromise persistence. */ }
  }
  async saveProvider(input = {}) {
    const previous = input.id ? this._get(input.id) : null;
    const name = textField(input.name ?? previous?.name, 'API 名称', 100);
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? previous?.baseUrl);
    const protocol = input.protocol ?? previous?.protocol;
    if (!PROTOCOLS.has(protocol)) fail('API 协议无效。');
    let ciphertext = previous?.ciphertext || null;
    const key = input.apiKey;
    if (key !== undefined && typeof key !== 'string') fail('API 密钥无效。');
    if (key && (key.length > 8192 || /[\u0000-\u001f\u007f]/.test(key))) fail('API 密钥无效。');
    if (input.clearKey === true) ciphertext = null;
    else if (key) {
      if (!this.vault?.isAvailable?.()) fail('系统安全存储不可用，无法保存 API 密钥。');
      try { const encrypted = this.vault.encrypt(key); if (!Buffer.isBuffer(encrypted) || !encrypted.length) fail('密钥加密失败。'); ciphertext = encrypted.toString('base64'); }
      catch { fail('无法使用系统安全存储加密密钥。'); }
    }
    const changed = !previous || baseUrl !== previous.baseUrl || protocol !== previous.protocol || !!key || input.clearKey === true;
    const models = input.models === undefined && previous ? clone(previous.models) : modelsFrom(input.models);
    if (changed) for (const model of models) model.ready = false;
    else if (input.models !== undefined) for (const model of models) {
      const found = previous.models.find(item => item.id === model.id);
      if (found?.ready) { model.ready = true; model.source = found.source; }
    }
    const record = { id: previous?.id || `api-${randomUUID()}`, name, baseUrl, protocol, ciphertext, models,
      ready: !changed && models.some(model => model.ready), status: !changed && models.some(model => model.ready) ? 'verified' : 'unverified', error: null };
    if (!previous && this.records.size >= 100) fail('API 连接数量已达上限。');
    this.records.set(record.id, record);
    await this._persist();
    return this._metadata(record);
  }
  async removeProvider(id) { this._get(id); this.records.delete(typeof id === 'object' ? id.id : id); await this._persist(); return true; }
  _key(record) {
    if (!record.ciphertext) return null;
    if (!this.vault?.isAvailable?.()) fail('系统安全存储不可用。');
    try { return this.vault.decrypt(Buffer.from(record.ciphertext, 'base64')); } catch { fail('无法解密 API 密钥，请重新设置。'); }
  }
  _redact(value) {
    let safe = String(value);
    for (const record of this.records.values()) {
      if (record.ciphertext) safe = safe.split(record.ciphertext).join('[redacted]');
      try { const key = this._key(record); if (key) for (const form of [key, encodeURIComponent(key), Buffer.from(key).toString('base64')]) safe = safe.split(form).join('[redacted]'); } catch { /* Do not expose decryption errors. */ }
    }
    return safe.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/\bsk[-_][a-zA-Z0-9_-]{8,}/g, '[redacted]');
  }
  async _request(record, endpoint, body, { signal, timeoutMs = this.timeoutMs } = {}) {
    checkAbort(signal);
    const baseUrl = normalizeBaseUrl(record.baseUrl);
    const url = new URL(`${baseUrl}/${endpoint}`);
    if (url.origin !== new URL(baseUrl).origin) fail('API 请求地址无效。');
    const headers = { Accept: 'application/json' };
    const key = this._key(record);
    if (record.protocol === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; if (key) headers['x-api-key'] = key; }
    else if (key) headers.Authorization = `Bearer ${key}`;
    let serialized;
    if (body !== undefined) { serialized = JSON.stringify(body); if (Buffer.byteLength(serialized) > MAX_REQUEST) fail('API 请求超过大小限制。'); headers['Content-Type'] = 'application/json'; }
    const controller = new AbortController();
    let expired = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
    timer.unref?.();
    try {
      const response = await abortable(this.fetchImpl(url.href, { method: body === undefined ? 'GET' : 'POST', headers, body: serialized, redirect: 'error', signal: controller.signal }), controller.signal);
      if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== url.origin) fail('API 重定向已拒绝。');
      if (!response.ok) {
        const error = new Error(`API 返回 HTTP ${Number(response.status) || '错误'}。`); error.status = response.status;
        if (response.status === 401 || response.status === 403) {
          record.ready = false; record.status = 'unverified'; record.error = error.message;
          record.models = record.models.map(model => ({ ...model, ready: false }));
          await this._persist();
        }
        throw error;
      }
      const declared = Number(response.headers?.get?.('content-length'));
      if (declared > MAX_RESPONSE) fail('API 响应超过大小限制。');
      let responseText;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = []; let bytes = 0;
        try {
          for (;;) { checkAbort(signal); const { value, done } = await abortable(reader.read(), controller.signal); if (done) break; bytes += value.byteLength; if (bytes > MAX_RESPONSE) { void reader.cancel().catch(() => {}); fail('API 响应超过大小限制。'); } chunks.push(Buffer.from(value)); }
          responseText = Buffer.concat(chunks).toString('utf8');
        } finally { try { reader.releaseLock(); } catch { /* An aborted read may still be settling. */ } }
      } else { responseText = await abortable(response.text(), controller.signal); if (Buffer.byteLength(responseText) > MAX_RESPONSE) fail('API 响应超过大小限制。'); }
      checkAbort(signal);
      try { return JSON.parse(responseText); } catch { fail('API 未返回有效 JSON。'); }
    } catch (error) {
      if (signal?.aborted) throw canceled();
      if (expired) fail('API 请求超时。');
      // Never include remote bodies, request headers or a fetch error's cause.
      if (error.status || /^(API |系统安全|无法解密)/.test(error.message)) throw error;
      fail('API 网络请求失败，请检查地址和连接。');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async refreshModels(id) {
    const record = this._get(id);
    try {
      const result = await this._request(record, 'models');
      if (!Array.isArray(result.data) || !result.data.length) fail('API 未返回可用模型列表。');
      const discovered = modelsFrom(result.data.filter(item => typeof item?.id === 'string' && item.lifecycle !== 'retired').map(item => ({ id: item.id, label: item.display_name || item.name || item.id,
        efforts: item.capabilities?.effort?.supported ? [...EFFORTS].filter(level => item.capabilities.effort[level]?.supported === true) : record.models.find(model => model.id === item.id)?.efforts || [] })), 'models', true);
      if (!discovered.length) fail('API 未返回可用模型列表。');
      record.models = [...discovered, ...record.models.filter(model => !discovered.some(item => item.id === model.id)).map(model => ({ ...model, ready: false }))];
      record.ready = true; record.status = 'verified'; record.error = null;
    } catch (error) {
      record.models = record.models.map(model => ({ ...model, ready: false })); record.ready = false; record.status = 'unverified'; record.error = this._redact(error.message);
      await this._persist();
      throw new Error(record.error);
    }
    await this._persist(); return this._metadata(record);
  }
  _selection(record, stage = {}) {
    const id = stage.model && stage.model !== 'default' ? textField(stage.model, '模型名称') : record.models.find(model => model.ready)?.id || record.models[0]?.id;
    if (!id) fail('请先添加或获取模型。');
    const effort = stage.effort && stage.effort !== 'default' ? stage.effort : null;
    if (effort && !EFFORTS.has(effort)) fail('思考强度无效。');
    if (effort && record.protocol === 'anthropic' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) fail('此协议不支持该思考强度。');
    const model = record.models.find(item => item.id === id);
    if (effort && model?.efforts?.length && !model.efforts.includes(effort)) fail('此模型不支持该思考强度。');
    return { model: id, effort };
  }
  _body(record, selection, history, tools, probe = false) {
    const max = probe ? 64 : 8192;
    const specs = tools || [];
    if (record.protocol === 'anthropic') return { model: selection.model, max_tokens: max, messages: history,
      ...(selection.effort ? { output_config: { effort: selection.effort } } : {}),
      ...(specs.length ? { tools: specs.map(spec => ({ name: spec.name, description: spec.description, input_schema: spec.parameters })) } : {}) };
    if (record.protocol === 'responses') return { model: selection.model, input: history, max_output_tokens: max, store: false, include: ['reasoning.encrypted_content'],
      ...(selection.effort ? { reasoning: { effort: selection.effort } } : {}),
      ...(specs.length ? { tools: specs.map(spec => ({ type: 'function', ...spec, strict: false })) } : {}) };
    return { model: selection.model, messages: history, max_completion_tokens: max,
      ...(selection.effort ? { reasoning_effort: selection.effort } : {}),
      ...(specs.length ? { tools: specs.map(spec => ({ type: 'function', function: spec })) } : {}) };
  }
  _parse(record, result) {
    if (record.protocol === 'anthropic') {
      if (!Array.isArray(result.content)) fail('API 响应缺少消息内容。');
      return { text: result.content.filter(item => item.type === 'text').map(item => item.text || '').join(''),
        calls: result.content.filter(item => item.type === 'tool_use').map(item => ({ id: item.id, name: item.name, args: item.input })), history: { role: 'assistant', content: result.content }, id: result.id };
    }
    if (record.protocol === 'responses') {
      if (!Array.isArray(result.output)) fail('API 响应缺少输出。');
      if (result.status === 'failed' || result.error) fail('API 模型返回执行失败。');
      return { text: result.output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join(''),
        calls: result.output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, args: item.arguments })), history: result.output, id: result.id };
    }
    const message = result.choices?.[0]?.message;
    if (!message) fail('API 响应缺少消息内容。');
    return { text: typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(item => item.type === 'text').map(item => item.text || '').join('') : '',
      calls: (message.tool_calls || []).map(item => ({ id: item.id, name: item.function?.name, args: item.function?.arguments })),
      history: { role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) }, id: result.id };
  }
  async probeProvider(id, model) {
    const record = this._get(id);
    const selection = this._selection(record, { model: typeof model === 'object' ? model.model || model.id : model });
    try {
      const result = await this._request(record, record.protocol === 'openai' ? 'chat/completions' : record.protocol === 'responses' ? 'responses' : 'messages',
        this._body(record, selection, [{ role: 'user', content: 'Reply with OK only. Do not use tools.' }], [], true), { timeoutMs: Math.min(this.timeoutMs, 30000) });
      const parsed = this._parse(record, result);
      if (!parsed.text.trim() || parsed.calls.length) fail('API 连接检测未得到文本回复。');
      let selected = record.models.find(item => item.id === selection.model);
      if (!selected) { selected = { id: selection.model, label: selection.model, efforts: [], ready: true, source: 'probe' }; record.models.push(selected); }
      selected.ready = true; selected.source = 'probe'; record.ready = true; record.status = 'verified'; record.error = null;
      await this._persist(); return this._metadata(record);
    } catch (error) {
      const selected = record.models.find(item => item.id === selection.model); if (selected) selected.ready = false;
      record.ready = record.models.some(item => item.ready); record.status = record.ready ? 'verified' : 'unverified'; record.error = this._redact(error.message);
      await this._persist(); throw new Error(record.error);
    }
  }
  async runProvider({ provider, stage = {}, prompt, workspace, onEvent = () => {}, signal } = {}) {
    checkAbort(signal);
    const record = this._get(provider);
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 2 * MAX_FILE) fail('任务内容为空或超过大小限制。');
    const selection = this._selection(record, stage);
    const tools = toolSpecs(readOnly(stage));
    const execute = await workspaceTools(workspace, readOnly(stage), signal);
    const history = [{ role: 'user', content: prompt }];
    const total = emptyUsage(); let text = ''; let sessionId;
    const emit = (type, value) => { try { onEvent({ type, ...value }); } catch { /* UI callbacks do not affect execution. */ } };
    const endpoint = record.protocol === 'openai' ? 'chat/completions' : record.protocol === 'responses' ? 'responses' : 'messages';
    const deadline = Date.now() + 30 * 60 * 1000;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      checkAbort(signal);
      const remaining = deadline - Date.now(); if (remaining <= 0) fail('API 任务超时。');
      const result = await this._request(record, endpoint, this._body(record, selection, history, tools), { signal, timeoutMs: Math.min(this.timeoutMs, remaining) });
      const parsed = this._parse(record, result);
      sessionId = typeof parsed.id === 'string' ? parsed.id.slice(0, 200) : sessionId;
      addUsage(total, usageFrom(result.usage, record.protocol), round === 0);
      emit('usage', { usage: clone(total) });
      if (parsed.text) {
        text += this._redact(parsed.text);
        if (Buffer.byteLength(text) > MAX_TEXT) fail('模型输出超过大小限制。');
        emit('text', { text, replace: true });
        emit('message', { id: `api-round-${round + 1}`, role: 'assistant', text: this._redact(parsed.text), time: new Date().toISOString() });
      }
      if (!parsed.calls.length) return { text, usage: total, ...(sessionId ? { sessionId } : {}) };
      if (parsed.calls.length > 16) fail('单轮工具调用超过限制。');
      if (record.protocol === 'responses') history.push(...parsed.history); else history.push(parsed.history);
      const results = [];
      for (const call of parsed.calls) {
        checkAbort(signal);
        if (typeof call.id !== 'string' || call.id.length > 300) fail('API 工具调用标识无效。');
        let output; let isError = false;
        emit('activity', { message: `API · ${['list_files', 'read_file', 'write_file'].includes(call.name) ? call.name : '未知工具'}` });
        try {
          const args = typeof call.args === 'string' ? JSON.parse(call.args) : call.args;
          output = await execute(call.name, args);
        } catch (error) { if (signal?.aborted) throw canceled(); output = JSON.stringify({ error: this._redact(error.message).slice(0, 1000) }); isError = true; }
        if (record.protocol === 'responses') results.push({ type: 'function_call_output', call_id: call.id, output });
        else if (record.protocol === 'anthropic') results.push({ type: 'tool_result', tool_use_id: call.id, content: output, ...(isError ? { is_error: true } : {}) });
        else results.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
      if (record.protocol === 'anthropic') history.push({ role: 'user', content: results }); else history.push(...results);
    }
    fail('API 工具调用达到 12 轮上限。');
  }
}

module.exports = { ApiRegistry };

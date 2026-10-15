'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {redact,normalizedUsage}=require('./domain.cjs');
const LIMIT=2*1024*1024;
const MAX_FILE=8*1024*1024;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text=(value,max=256)=>typeof value==='string'?redact(value).slice(0,max):null;
function privateDirectory(dir){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const info=fs.lstatSync(dir);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('对话存储目录已被替换');
  fs.chmodSync(dir,0o700);
}
class ConversationStore{
  constructor({dataDir,validate}={}){
    if(typeof validate!=='function')throw new Error('对话存储需要任务校验');
    privateDirectory(path.resolve(dataDir));this.root=path.join(fs.realpathSync(dataDir),'conversations');privateDirectory(this.root);this.validate=validate;this.cache=new Map();
  }
  cacheKey(ids){return [ids?.runId,ids?.stageId,ids?.attemptId].join('\0');}
  metadata(ids){const found=this.cache.get(this.cacheKey(ids));return found?{...found}:null;}
  cacheMetadata(record){this.cache.set(this.cacheKey(record),{actualModelId:record.actualModelId,modelId:record.modelId,providerId:record.providerId});return record;}
  check(ids,runOnly=false){
    if(!ids||!uuid(ids.runId)||!runOnly&&(!/^[a-zA-Z0-9_-]{1,100}$/.test(ids.stageId||'')||!uuid(ids.attemptId))||
      this.validate(runOnly?{runId:ids.runId}:{runId:ids.runId,stageId:ids.stageId,attemptId:ids.attemptId})!==true)throw new Error('对话记录不存在');
    if(fs.lstatSync(this.root).isSymbolicLink()||fs.realpathSync(this.root)!==this.root)throw new Error('对话存储目录已被替换');
  }
  runPath(runId){this.check({runId},true);const dir=path.join(this.root,runId);if(fs.existsSync(dir)&&(fs.lstatSync(dir).isSymbolicLink()||!fs.lstatSync(dir).isDirectory()))throw new Error('对话存储目录已被替换');return dir;}
  file(ids){this.check(ids);const dir=this.runPath(ids.runId);const name=crypto.createHash('sha256').update(ids.stageId+'\0'+ids.attemptId).digest('hex')+'.json';return {dir,target:path.join(dir,name)};}
  get(ids){
    const {target}=this.file(ids);let stat;
    try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(stat.isSymbolicLink()||!stat.isFile()||stat.size>MAX_FILE)throw new Error('对话记录不可读取');
    const fd=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{const data=JSON.parse(fs.readFileSync(fd,'utf8'));if(data.runId!==ids.runId||data.stageId!==ids.stageId||data.attemptId!==ids.attemptId)throw new Error();return this.cacheMetadata(this.publicRecord(data));}
    catch{throw new Error('对话记录不可读取');}finally{fs.closeSync(fd);}
  }
  publicRecord(raw){
    const input=typeof raw.input==='string'?redact(raw.input):null,output=typeof raw.output==='string'?redact(raw.output):'';
    if(input!==null&&Buffer.byteLength(input)>LIMIT||Buffer.byteLength(output)>LIMIT)throw new Error('对话内容超过保存上限');
    let messageBytes=0;
    const messages=(Array.isArray(raw.messages)?raw.messages:[]).slice(0,1000).filter(row=>row?.role==='assistant'&&typeof row.text==='string').map(row=>{
      const body=redact(row.text);messageBytes+=Buffer.byteLength(body);if(messageBytes>LIMIT)throw new Error('公开回复超过保存上限');
      return {id:text(row.id,200),role:'assistant',text:body,time:text(row.time,40)};
    });
    return {runId:raw.runId,stageId:raw.stageId,attemptId:raw.attemptId,input,inputCaptured:input!==null&&raw.inputCaptured!==false,
      output,providerId:text(raw.providerId),modelId:text(raw.modelId),actualModelId:text(raw.actualModelId),effort:text(raw.effort,40),sessionId:text(raw.sessionId,256),
      origin:text(raw.origin,100)||'provider',status:text(raw.status,40),startedAt:text(raw.startedAt,40),finishedAt:text(raw.finishedAt,40),
      usage:normalizedUsage(raw.usage),truncated:raw.truncated===true,legacy:raw.legacy===true,messages,
      messageCapture:['final-only','public-messages'].includes(raw.messageCapture)?raw.messageCapture:null,
      activities:(Array.isArray(raw.activities)?raw.activities:[]).slice(-1000).map(row=>({time:text(row?.time,40),type:text(row?.type,40),message:text(row?.message,512)}))};
  }
  save(raw){
    const {dir,target}=this.file(raw);privateDirectory(dir);const previous=this.get(raw)||{};
    const data=this.publicRecord({...previous,...raw});const serialized=JSON.stringify(data);
    if(Buffer.byteLength(serialized)>MAX_FILE)throw new Error('对话记录超过保存上限');
    if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw new Error('对话记录已被替换');
    const temporary=path.join(dir,'.'+crypto.randomUUID()+'.tmp');
    try{fs.writeFileSync(temporary,serialized,{encoding:'utf8',mode:0o600,flag:'wx'});fs.renameSync(temporary,target);fs.chmodSync(target,0o600);}
    finally{try{fs.unlinkSync(temporary);}catch{}}
    return this.cacheMetadata(data);
  }
}
module.exports={ConversationStore,MAX_CONVERSATION_TEXT_BYTES:LIMIT};

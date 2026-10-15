'use strict';
// Read only one explicitly known vendor session. No database search or auth read.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {redact}=require('./domain.cjs');
const LIMIT=2*1024*1024;
function readOfficialConversation({providerId,sessionId,workspace,startedAt,finishedAt,expectedPrompt,home=os.homedir(),codexHome}={}){
 if(!['codex','workbuddy'].includes(providerId)||typeof sessionId!=='string'||!/^[0-9a-f-]{36}$/i.test(sessionId)||typeof workspace!=='string'||!path.isAbsolute(workspace))return null;
 try{
  const start=Date.parse(startedAt),end=finishedAt?Date.parse(finishedAt):Date.now();if(!Number.isFinite(start)||!Number.isFinite(end))return null;
  const root=providerId==='codex'?path.join(codexHome||process.env.CODEX_HOME||path.join(home,'.codex'),'sessions'):path.join(home,'.codebuddy','projects');
  let target;
  if(providerId==='codex'){
   const matches=[];for(const offset of [-86400000,0,86400000]){const date=new Date(start+offset).toISOString().slice(0,10).split('-');const folder=path.join(root,...date);let files=[];try{files=fs.readdirSync(folder);}catch{}for(const name of files)if(name.startsWith('rollout-')&&name.endsWith('-'+sessionId+'.jsonl'))matches.push(path.join(folder,name));}
   const unique=[...new Set(matches)];if(unique.length!==1)return null;target=unique[0];
  }else target=path.join(root,fs.realpathSync(workspace).replace(/^\/+/, '').replace(/\//g,'-'),sessionId+'.jsonl');
  const realRoot=fs.realpathSync(root);if(!fs.realpathSync(target).startsWith(realRoot+path.sep))return null;
  const stat=fs.lstatSync(target);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>8*1024*1024)return null;
  const fd=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));let lines;try{lines=fs.readFileSync(fd,'utf8').split('\n').filter(Boolean).map(JSON.parse);}finally{fs.closeSync(fd);}
  const visibleText=content=>Array.isArray(content)?content.filter(x=>['input_text','output_text','text'].includes(x?.type)&&typeof x.text==='string').map(x=>x.text).join('\n'):typeof content==='string'?content:'';
  const inWindow=row=>{const when=typeof row.timestamp==='number'?row.timestamp:Date.parse(row.timestamp);return Number.isFinite(when)&&when>=start-15000&&when<=end+15000;};
  let users,assistants,model,effort;
  if(providerId==='codex'){
   const meta=lines.find(x=>x.type==='session_meta')?.payload;
   if(meta?.id!==sessionId||meta.cwd!==workspace||meta.source!=='exec'||lines.filter(x=>x.type==='event_msg'&&x.payload?.type==='task_started').length!==1)return null;
   users=lines.filter(x=>x.type==='response_item'&&x.payload?.type==='message'&&x.payload?.role==='user'&&inWindow(x));
   assistants=lines.filter(x=>x.type==='response_item'&&x.payload?.type==='message'&&x.payload?.role==='assistant'&&['commentary','final_answer','final'].includes(x.payload.phase)&&inWindow(x)).map(x=>({id:x.payload.id,role:'assistant',text:visibleText(x.payload.content),time:x.timestamp,final:['final_answer','final'].includes(x.payload.phase)}));
   const turns=lines.filter(x=>x.type==='turn_context'&&x.payload?.cwd===workspace&&inWindow(x));if(turns.length!==1)return null;model=turns[0].payload.model;effort=turns[0].payload.effort;
  }else{
   const rows=lines.filter(x=>x.type==='message'&&x.sessionId===sessionId&&x.cwd===workspace&&inWindow(x));
   users=rows.filter(x=>x.role==='user');if(users.length!==1)return null;
   assistants=rows.filter(x=>x.role==='assistant').map(x=>({id:x.id,role:'assistant',text:visibleText(x.content),time:new Date(x.timestamp).toISOString(),final:x.status==='completed'||x.status==='success'}));
   model=rows.filter(x=>x.role==='assistant').at(-1)?.providerData?.model;
  }
  if(!users.length||!assistants.length)return null;
  const input=visibleText(providerId==='codex'?users.at(-1).payload.content:users[0].content);
  if(!input||typeof expectedPrompt==='string'&&input.trim()!==expectedPrompt.trim())return null;
  let truncated=false;const bounded=(value,budget=LIMIT)=>{const raw=Buffer.from(redact(value));if(raw.length<=budget)return raw.toString();truncated=true;return raw.subarray(0,budget).toString('utf8').replace(/\ufffd$/,'');};
  let budget=LIMIT;const messages=[];for(let i=0;i<assistants.length&&budget>0;i++){const row=assistants[i],body=bounded(row.text,budget);budget-=Buffer.byteLength(body);messages.push({id:typeof row.id==='string'?row.id.slice(0,200):providerId+'-public-'+i,role:'assistant',text:body,time:row.time});}
  if(messages.length<assistants.length)truncated=true;
  const finals=assistants.filter(x=>x.final);const output=bounded((finals.length?finals:[assistants.at(-1)]).map(x=>x.text).join('\n\n'));
  const actualModelId=typeof model==='string'&&model.length<=200&&!/[\u0000-\u001f]/.test(model)?redact(model):null;
  return {input:bounded(input),inputCaptured:true,output,messages,actualModelId,effort:typeof effort==='string'?effort.slice(0,40):null,sessionId,origin:'official-cli-log',truncated};
 }catch{return null;}
}
module.exports={readOfficialConversation};

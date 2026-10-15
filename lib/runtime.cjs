'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const OFFICIAL_PACKAGES=new Set(['@openai/codex','@anthropic-ai/claude-code','@tencent-ai/codebuddy-code']);
function publicPackage(entry){
  let directory=path.dirname(entry);
  for(let depth=0;depth<8;depth++){
    const file=path.join(directory,'package.json');
    try{if(fs.statSync(file).size<=512*1024){const metadata=JSON.parse(fs.readFileSync(file,'utf8'));
      const bins=typeof metadata.bin==='string'?[metadata.bin]:Object.values(metadata.bin||{});
      if(OFFICIAL_PACKAGES.has(metadata.name)&&bins.some(bin=>typeof bin==='string'&&path.resolve(directory,bin)===entry))return metadata;
    }}catch{}
    const parent=path.dirname(directory);if(parent===directory)break;directory=parent;
  }
  return null;
}
function resolveNpmShim(file){
  try{
    if(fs.statSync(file).size>64*1024)return null;
    const source=fs.readFileSync(file,'utf8');
    for(const match of source.matchAll(/(?:%dp0%|%~dp0)[\\/]([^"\r\n]+)(?=")/gi)){
      const entry=path.resolve(path.dirname(file),match[1].replace(/\\/g,path.sep));
      try{if(fs.statSync(entry).isFile()&&publicPackage(entry))return entry;}catch{}
    }
  }catch{}
  return null;
}
function resolveCLIInvocation({executable,args=[],nodePath=process.execPath,env=process.env,platform=process.platform}={}){
  if(typeof executable!=='string'||!executable||/[\u0000-\u001f]/.test(executable)||!Array.isArray(args)||args.some(arg=>typeof arg!=='string'||arg.includes('\0')))throw new Error('命令行入口或参数无效');
  let entry=executable,fromNpm=false;
  if(/\.(?:cmd|bat)$/i.test(entry)){
    entry=resolveNpmShim(entry);if(!entry)throw new Error('未找到经过确认的官方 CLI 程序入口；不能直接执行命令脚本');fromNpm=true;
  }
  const environment={...env};
  let nodeScript=fromNpm||/\.(?:mjs|cjs|js)$/i.test(entry),portableExecutable=false;
  if(platform==='win32'&&!nodeScript&&!/\.(?:exe|com)$/i.test(entry)){
    try{const fd=fs.openSync(entry,'r');const buffer=Buffer.alloc(256);try{const read=fs.readSync(fd,buffer,0,buffer.length,0);nodeScript=/^#![^\r\n]*\bnode(?:\.exe)?(?:\s|$)/i.test(buffer.toString('utf8',0,read));portableExecutable=buffer[0]===0x4d&&buffer[1]===0x5a;}finally{fs.closeSync(fd);}}catch{}
    if(!nodeScript&&!portableExecutable)throw new Error('Windows 需要原生可执行文件或 Node CLI 入口，不能运行 POSIX 脚本');
  }
  if(nodeScript){
    if(typeof nodePath!=='string'||!nodePath||/[\u0000-\u001f]/.test(nodePath))throw new Error('Node 运行时不可用');
    if(nodePath===process.execPath&&process.versions.electron)environment.ELECTRON_RUN_AS_NODE='1';
    return {command:nodePath,args:[entry,...args],env:environment,shell:false};
  }
  return {command:entry,args:[...args],env:environment,shell:false};
}
function findCLI(name,{extra=[],platform=process.platform,home=os.homedir(),env=process.env}={}){
  const windows=platform==='win32';
  const directories=[...(windows?[path.join(env.APPDATA||path.join(home,'AppData','Roaming'),'npm'),path.join(home,'.local','bin')]:[]),
    ...(env.PATH||env.Path||'').split(windows?';':path.delimiter).filter(Boolean)];
  const extensions=windows?['.exe','.com','','.cmd']:[''];
  for(const file of [...extra,...directories.flatMap(directory=>extensions.map(extension=>path.join(directory,name+extension)))]){
    try{fs.accessSync(file,fs.constants.X_OK);if(!fs.statSync(file).isFile())continue;
      if(/\.(?:cmd|bat)$/i.test(file)){const entry=resolveNpmShim(file);if(entry)return entry;continue;}
      if(windows)resolveCLIInvocation({executable:file,platform});
      return file;
    }catch{}
  }
  return null;
}
function windowsApplicationRoots({home=os.homedir(),env=process.env}={}){
  return [...new Set([path.join(env.LOCALAPPDATA||path.join(home,'AppData','Local'),'Programs'),env.ProgramFiles||env.PROGRAMFILES,env['ProgramFiles(x86)']].filter(Boolean))];
}
function terminateProcessTree(child,{force=false,platform=process.platform,spawnImpl=spawn,killImpl=process.kill}={}){
  if(!Number.isSafeInteger(child?.pid)||child.pid<=0)return Promise.resolve();
  if(platform!=='win32'){
    try{killImpl(-child.pid,force?'SIGKILL':'SIGTERM');}catch{try{child.kill(force?'SIGKILL':'SIGTERM');}catch{}}
    return Promise.resolve();
  }
  return new Promise(resolve=>{
    let killer;try{
      const systemRoot=process.env.SystemRoot||process.env.SYSTEMROOT||'C:\\Windows';
      killer=spawnImpl(path.win32.join(systemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T',...(force?['/F']:[])],
        {shell:false,windowsHide:true,stdio:'ignore'});
    }catch{try{child.kill(force?'SIGKILL':'SIGTERM');}catch{}resolve();return;}
    let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);resolve();};
    const timer=setTimeout(()=>{try{killer.kill();}catch{}finish();},5000);timer.unref?.();
    killer.once('error',finish);killer.once('close',finish);
  });
}
module.exports={resolveCLIInvocation,terminateProcessTree,findCLI,windowsApplicationRoots,publicPackage};

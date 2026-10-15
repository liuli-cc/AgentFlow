'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');

// Squirrel owns these events. Do not initialize user data or agent discovery.
function handleInstallerEvent({app,platform=process.platform,argv=process.argv,execPath=process.execPath,spawnImpl=spawn,setTimeoutImpl=setTimeout}={}){
  if(platform!=='win32'||!Array.isArray(argv))return false;
  const event=argv[1];
  if(!['--squirrel-install','--squirrel-updated','--squirrel-uninstall','--squirrel-obsolete'].includes(event))return false;
  if(event==='--squirrel-obsolete'){app.quit();return true;}
  const updater=path.win32.resolve(path.win32.dirname(execPath),'..','Update.exe');
  const operation=event==='--squirrel-uninstall'?'--removeShortcut':'--createShortcut';
  let timer,finished=false;
  const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);app.quit();};
  try{
    const child=spawnImpl(updater,[operation,path.win32.basename(execPath)],{shell:false,windowsHide:true,stdio:'ignore'});
    child.once('error',finish);child.once('close',finish);
    timer=setTimeoutImpl(finish,5000);timer.unref?.();
  }catch{finish();}
  return true;
}
module.exports={handleInstallerEvent};

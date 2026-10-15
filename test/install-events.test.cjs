'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {handleInstallerEvent}=require('../lib/install-events.cjs');
test('Windows installer events create/remove exact application shortcuts without starting the workbench',()=>{
  for(const [event,operation] of [['--squirrel-install','--createShortcut'],['--squirrel-updated','--createShortcut'],['--squirrel-uninstall','--removeShortcut']]){
    let quits=0,call;const child=new EventEmitter();
    const handled=handleInstallerEvent({app:{quit(){quits++;}},platform:'win32',argv:['AgentFlow.exe',event,'0.4.2'],execPath:'C:\\Users\\Example\\AgentFlow\\app-0.4.2\\AgentFlow.exe',spawnImpl:(command,args,options)=>{call={command,args,options};return child;}});
    assert.equal(handled,true);assert.equal(quits,0);assert.equal(call.command,'C:\\Users\\Example\\AgentFlow\\Update.exe');assert.deepEqual(call.args,[operation,'AgentFlow.exe']);assert.equal(call.options.shell,false);
    child.emit('close',0);child.emit('error',new Error('late'));assert.equal(quits,1);
  }
});
test('Only exact Windows installer entry flags are handled; first run remains a normal app launch',()=>{
  let quits=0;const app={quit(){quits++;}};
  for(const argv of [[],['app','--squirrel-firstrun'],['app','--other','--squirrel-install'],['app','--squirrel-install & echo unsafe']])assert.equal(handleInstallerEvent({app,platform:'win32',argv}),false);
  assert.equal(handleInstallerEvent({app,platform:'darwin',argv:['app','--squirrel-install']}),false);
  assert.equal(handleInstallerEvent({app,platform:'win32',argv:['app','--squirrel-obsolete']}),true);assert.equal(quits,1);
});
test('Installer updater errors terminate the event cleanly',()=>{
  let quits=0;const app={quit(){quits++;}};
  assert.equal(handleInstallerEvent({app,platform:'win32',argv:['app','--squirrel-install'],spawnImpl:()=>{throw new Error('missing Update.exe');}}),true);assert.equal(quits,1);
});

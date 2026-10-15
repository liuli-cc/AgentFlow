'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');const {createRequire}=require('node:module');const {pathToFileURL}=require('node:url');
for(const platform of ['darwin','win32'])test(`window appears before initialization and recreates on ${platform}`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-lifecycle-'));t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const main=path.resolve(__dirname,'../main.cjs'),actual=createRequire(main),events=new Map(),windows=[],handlers=new Map();let resolveReady,releaseRegistry;
 const ready=new Promise(resolve=>{resolveReady=resolve;}),registryReady=new Promise(resolve=>{releaseRegistry=resolve;});
 class Window extends EventEmitter{constructor(options){super();this.options=options;this.shown=options.show;this.focused=false;this.minimized=false;const contents=new EventEmitter();Object.assign(contents,{id:windows.length+1,mainFrame:{url:pathToFileURL(path.resolve(__dirname,'../ui/index.html')).href},setWindowOpenHandler(){},isLoading:()=>false,send(){},session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onBeforeRequest(){}}}});this.webContents=contents;windows.push(this);}show(){this.shown=true;}focus(){this.focused=true;}isMinimized(){return this.minimized;}restore(){this.minimized=false;}isDestroyed(){return false;}loadFile(){queueMicrotask(()=>this.webContents.emit('did-finish-load'));return Promise.resolve();}}
 class FakeWorker extends EventEmitter{constructor(_code,options){super();assert.equal(options.eval,true);assert.match(options.workerData.modulePath,/providers\.cjs$/);setImmediate(()=>this.emit('message',{known:[]}));}terminate(){return Promise.resolve(0);}}
 class Registry{async init(){await registryReady;}getProviders(){return [];}}
 class Telemetry{get(){return null;}start(){}stop(){}}
 class Watcher{start(){}stop(){}}
 const electron={app:{setName(){},setPath(){},requestSingleInstanceLock:()=>true,getPath:()=>dir,on:(name,fn)=>events.set(name,fn),whenReady:()=>ready,isReady:()=>true,isPackaged:false,quit(){throw new Error('unexpected quit');}},BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showErrorBox(_title,message){throw new Error(message);}},shell:{},clipboard:{},nativeTheme:{},safeStorage:{isEncryptionAvailable:()=>false}};
 const context={require:name=>name==='electron'?electron:name==='node:worker_threads'?{Worker:FakeWorker}:name==='./lib/api-providers.cjs'?{ApiRegistry:Registry}:name==='./lib/telemetry.cjs'?{Telemetry}:name==='./lib/discovery.cjs'?{DiscoveryWatcher:Watcher,discoverApplications:()=>[]}:actual(name),__dirname:path.dirname(main),module:{exports:{}},process:{env:{},resourcesPath:path.dirname(main),platform,argv:[process.execPath],execPath:process.execPath},Buffer,AbortController,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(main,'utf8')+'\n;globalThis.qa={isInitializing:()=>initializing,getEngine:()=>engine};',context,{filename:main});
 resolveReady();await new Promise(resolve=>setImmediate(resolve));assert.equal(windows.length,1);assert.equal(windows[0].shown,true);assert.equal(context.qa.isInitializing(),true);assert.ok(handlers.has('agentflow:getState'));
 if(platform==='win32'){assert.equal(windows[0].options.titleBarStyle,undefined);assert.equal(windows[0].options.trafficLightPosition,undefined);}else assert.equal(windows[0].options.titleBarStyle,'hiddenInset');
 const first=windows[0];first.minimized=true;events.get('activate')();assert.equal(first.minimized,false);assert.equal(first.focused,true);
 first.emit('closed');events.get('second-instance')();assert.equal(windows.length,2);assert.equal(windows[1].shown,true);
 releaseRegistry();for(let i=0;i<20&&context.qa.isInitializing();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(context.qa.isInitializing(),false);
 windows[1].emit('closed');events.get('activate')();assert.equal(windows.length,3);assert.equal(windows[2].shown,true);context.qa.getEngine().shutdown();
});

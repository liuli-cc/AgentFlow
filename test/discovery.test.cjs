'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {discoverApplications,discoveryFingerprint,DiscoveryWatcher}=require('../lib/discovery.cjs');
function fakeApp(root,filename,name,id){
  const app=path.join(root,filename+'.app');fs.mkdirSync(path.join(app,'Contents'),{recursive:true});
  fs.writeFileSync(path.join(app,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>${name}</string><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>1.0</string></dict></plist>`);
  return app;
}
test('首扫、新安装和删除应用能被识别；只发现不假定已登录',{skip:process.platform!=='darwin'},t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-discovery-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const apps=path.join(home,'Applications');fs.mkdirSync(apps);
  const known=fakeApp(apps,'Claude','Claude','com.test.claude');
  fakeApp(apps,'普通文档','普通文档','com.test.document');
  const options={home,roots:[apps],knownProviders:[{appPath:known}]};
  assert.deepEqual(discoverApplications(options),[]);
  const before=discoveryFingerprint({home});
  const newAgent=fakeApp(apps,'OpenCode','OpenCode','com.test.opencode');
  fs.utimesSync(apps,new Date(),new Date(Date.now()+2000));
  assert.notEqual(discoveryFingerprint({home}),before);
  const p=discoverApplications(options);assert.equal(p.length,1);assert.equal(p[0].name,'OpenCode');assert.equal(p[0].ready,false);assert.equal(p[0].mode,'handoff');assert.equal(p[0].models[0].ready,false);
  assert.equal(p[0].authStatus,'client-managed');assert.equal(p[0].adapterStatus,'unavailable');
  assert.equal(p[0].readinessReason.code,'adapter-unavailable');assert.match(p[0].readinessReason.message,/账号由原应用管理/);
  fs.rmSync(newAgent,{recursive:true});assert.deepEqual(discoverApplications(options),[]);
});
test('同bundle去重、WebApp区分、符号链接应用不漏掉',{skip:process.platform!=='darwin'},t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-discovery-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const apps=path.join(home,'Applications');fs.mkdirSync(apps);
  const known=fakeApp(apps,'Doubao','豆包','com.test.doubao');
  fakeApp(apps,'豆包副本','豆包','com.test.doubao');
  fakeApp(apps,'豆包','豆包','com.apple.Safari.WebApp.test');
  const outside=fakeApp(home,'Gemini','Gemini','com.test.gemini');fs.symlinkSync(outside,path.join(apps,'Gemini.app'));
  const found=discoverApplications({home,roots:[apps],knownProviders:[{appPath:known}]});
  assert.equal(found.length,2);assert.ok(found.some(p=>p.name==='豆包 网页版'));assert.ok(found.some(p=>p.appPath===fs.realpathSync(outside)));
});
test('自动重扫合并并发变化且停止后不继续轮询',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-discovery-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  fs.mkdirSync(path.join(home,'Applications'));
  let calls=0,release;const gate=new Promise(r=>release=r);
  const watcher=new DiscoveryWatcher({home,roots:[path.join(home,'Applications')],intervalMs:1000,onChange:async()=>{calls++;await gate;}});watcher.start();t.after(()=>watcher.stop());
  fs.utimesSync(path.join(home,'Applications'),new Date(),new Date(Date.now()+2000));
  const first=watcher.check();await watcher.check();assert.equal(calls,1);release();await first;watcher.stop();assert.equal(watcher.busy,false);assert.equal(calls,1);
});
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-discovery-portable-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
function bundle(folder,name){const app=path.join(folder,name+'.app');fs.mkdirSync(path.join(app,'Contents'),{recursive:true});fs.writeFileSync(path.join(app,'Contents/Info.plist'),'public-metadata-fixture');return app;}
test('本地化或改名的Google应用按公开bundle metadata识别，不把Chrome浏览器当agent',t=>{
  const home=fixture(t),apps=path.join(home,'Applications');
  const renamed=bundle(apps,'创作工具'),chrome=bundle(apps,'Google Chrome');
  const metas=new Map([[fs.realpathSync(renamed),{name:'Antigravity',bundleId:'com.google.antigravity',version:'1.2'}],
    [fs.realpathSync(chrome),{name:'Google Chrome',bundleId:'com.google.Chrome',version:'1.0'}]]);
  const found=discoverApplications({home,roots:[apps],platform:'darwin',env:{},readAppMetadata:file=>metas.get(file)});
  assert.equal(found.length,1);assert.equal(found[0].name,'Antigravity');assert.equal(found[0].appPath,fs.realpathSync(renamed));
  assert.equal(found[0].executionTrust,'installed-location');
  assert.equal(found[0].ready,false);assert.equal(found[0].adapterStatus,'unavailable');assert.equal(found[0].models[0].ready,false);
});
test('默认扫描Downloads的有限解压目录，但不进入Library、隐藏目录或任意深度',t=>{
  const home=fixture(t),downloads=path.join(home,'Downloads');
  const visible=bundle(path.join(downloads,'Google','release'),'编辑器');
  bundle(path.join(downloads,'Library','Account'),'Gemini');bundle(path.join(downloads,'.private'),'Gemini');
  bundle(path.join(downloads,'a','b','c','d'),'Gemini');
  const inspected=[];
  const found=discoverApplications({home,platform:'darwin',cliRoots:[],env:{},readAppMetadata:file=>{
    inspected.push(file);return file===fs.realpathSync(visible)?{name:'Gemini',bundleId:'com.google.gemini',version:'1'}:null;
  }});
  assert.equal(found.length,1);assert.equal(found[0].appPath,fs.realpathSync(visible));
  assert.equal(found[0].executionTrust,'untrusted-discovery');
  assert(!inspected.some(file=>file.includes(path.join('Library','Account'))||file.includes('.private')||file.includes(path.join('a','b','c','d'))));
});
test('嵌套新装或更新bundle metadata会改变指纹，即使顶层Applications时间戳没变',t=>{
  const home=fixture(t),apps=path.join(home,'Applications'),nested=path.join(apps,'Google','release');fs.mkdirSync(nested,{recursive:true});
  const options={home,roots:[apps],platform:'darwin',env:{}};
  const rootStat=fs.statSync(apps),before=discoveryFingerprint(options);
  const app=bundle(nested,'Antigravity');fs.utimesSync(apps,rootStat.atime,rootStat.mtime);
  const installed=discoveryFingerprint(options);assert.notEqual(installed,before);
  fs.appendFileSync(path.join(app,'Contents/Info.plist'),'new-version');
  assert.notEqual(discoveryFingerprint(options),installed);
});
test('Windows识别LOCALAPPDATA直接用户安装位置，不扫描账号目录或把安装程序当应用',t=>{
  const home=fixture(t),local=path.join(home,'AppData','Local'),folder=path.join(local,'Google','Antigravity');fs.mkdirSync(folder,{recursive:true});
  const app=path.join(folder,'Antigravity.exe');fs.writeFileSync(app,'public-executable-fixture');fs.writeFileSync(path.join(folder,'AntigravitySetup.exe'),'installer');
  const account=path.join(local,'Account');fs.mkdirSync(account,{recursive:true});fs.writeFileSync(path.join(account,'Gemini.exe'),'private fixture must not be inspected');
  const options={home,platform:'win32',env:{LOCALAPPDATA:local,APPDATA:path.join(home,'Roaming'),PATH:''}};
  const found=discoverApplications(options);assert.equal(found.length,1);assert.equal(found[0].appPath,app);assert.equal(found[0].ready,false);
  assert(!discoveryFingerprint(options).includes(account));
});
test('Windows npm命令仅作为未验证入口发现，不执行.cmd或冒充登录成功；已知provider会去重',t=>{
  const home=fixture(t),bin=path.join(home,'npm');fs.mkdirSync(bin);
  const command=path.join(bin,'gemini.cmd'),marker=path.join(home,'must-not-exist');fs.writeFileSync(command,'echo unsafe > "'+marker+'"');
  const options={home,roots:[],cliRoots:[bin],platform:'win32',env:{}};
  const found=discoverApplications(options);assert.equal(found.length,1);assert.equal(found[0].id,'gemini');assert.equal(found[0].executable,command);
  assert.equal(found[0].discoverySource,'command-path');assert.equal(found[0].suggestedAdapter,'gemini-cli');assert.equal(found[0].ready,false);assert.equal(found[0].mode,'handoff');
  assert.match(found[0].readinessReason.message,/尚未验证/);assert(!fs.existsSync(marker));
  assert.deepEqual(discoverApplications({...options,knownProviders:[{id:'gemini',installed:false}]}),[]);
  assert.deepEqual(discoverApplications({...options,knownProviders:[{id:'other',executable:command.toUpperCase()}]}),[]);
  const before=discoveryFingerprint(options);fs.appendFileSync(command,'\nchanged');assert.notEqual(discoveryFingerprint(options),before);
});
test('离开PATH的版本管理器公开bin目录仍能发现Gemini命令',t=>{
  const home=fixture(t),bin=path.join(home,'.nvm','versions','node','v22.0.0','bin');fs.mkdirSync(bin,{recursive:true});
  const command=path.join(bin,'gemini');fs.writeFileSync(command,'#!/usr/bin/env node\nthrow Error("must never execute")');fs.chmodSync(command,0o755);
  const found=discoverApplications({home,platform:'win32',env:{LOCALAPPDATA:path.join(home,'Local'),APPDATA:path.join(home,'Roaming'),PATH:''}});
  assert.equal(found.length,1);assert.equal(found[0].executable,command);assert.equal(found[0].ready,false);
});
test('只跟随.app bundle链接、去重规范路径，不递归普通目录链接或循环',t=>{
  const home=fixture(t),apps=path.join(home,'Applications');fs.mkdirSync(apps);
  const outside=bundle(path.join(home,'outside'),'Gemini');
  fs.symlinkSync(path.dirname(outside),path.join(apps,'linked-folder'),'junction');
  const options={home,roots:[apps],platform:'darwin',env:{},readAppMetadata:()=>({name:'Gemini',bundleId:'com.google.gemini',version:'1'})};
  assert.deepEqual(discoverApplications(options),[]);
  fs.symlinkSync(outside,path.join(apps,'本地编辑器.app'),'junction');
  const found=discoverApplications(options);assert.equal(found.length,1);assert.equal(found[0].appPath,fs.realpathSync(outside));
  assert.deepEqual(discoverApplications({...options,knownProviders:[{appPath:outside}]}),[]);
});
test('Antigravity桌面启动器合并至客户端记录，Gemini独立CLI保留自己的认证边界',t=>{
  const home=fixture(t),apps=path.join(home,'Applications'),bin=path.join(home,'bin');fs.mkdirSync(bin);
  bundle(apps,'Antigravity');
  for(const name of ['antigravity','gemini']){const command=path.join(bin,name);fs.writeFileSync(command,'#!/usr/bin/env node\n');fs.chmodSync(command,0o755);}
  const found=discoverApplications({home,roots:[apps],cliRoots:[bin],platform:'darwin',env:{},readAppMetadata:()=>({name:'Antigravity',bundleId:'com.google.antigravity',version:'1'})});
  assert.equal(found.length,2);const app=found.find(p=>p.appPath),cli=found.find(p=>p.id==='gemini');
  assert.equal(app.cliLaunchers[0].executable,path.join(bin,'antigravity'));assert.equal(cli.appPath,null);assert.equal(cli.ready,false);
});
test('新增官方agy触发发现且与Antigravity IDE启动器保持不同执行边界',t=>{
  const home=fixture(t),bin=path.join(home,'bin');fs.mkdirSync(bin);
  const options={home,roots:[],cliRoots:[bin],platform:'win32',env:{}};
  fs.writeFileSync(path.join(bin,'antigravity.cmd'),'IDE launcher; do not execute');
  const before=discoveryFingerprint(options),launcher=discoverApplications(options)[0];
  assert.equal(launcher.id,'antigravity-launcher');assert.equal(launcher.suggestedAdapter,'antigravity-launcher');
  fs.writeFileSync(path.join(bin,'agy.cmd'),'official CLI entry fixture; do not execute');
  assert.notEqual(discoveryFingerprint(options),before);
  const found=discoverApplications(options),cli=found.find(p=>p.id==='antigravity');
  assert.equal(found.length,2);assert.equal(cli.cliName,'agy');assert.equal(cli.suggestedAdapter,'antigravity-cli');assert.equal(cli.executable,path.join(bin,'agy.cmd'));assert.equal(cli.ready,false);
});
test('Downloads bundle符号链接真实发现后即使规范目标在外部也保留不可信来源',{skip:process.platform!=='darwin'},t=>{
  const home=fixture(t),downloads=path.join(home,'Downloads');fs.mkdirSync(downloads);
  const outside=fakeApp(path.join(home,'outside'),'WorkBuddy AI','WorkBuddy AI','com.test.workbuddy');
  fs.symlinkSync(outside,path.join(downloads,'WorkBuddy AI.app'));
  // Use the production scanner AND plist parser, not a fabricated descriptor.
  const found=discoverApplications({home,roots:[downloads],platform:'darwin',env:{}});
  assert.equal(found.length,1);assert.equal(found[0].appPath,fs.realpathSync(outside));
  assert(!found[0].appPath.startsWith(downloads+path.sep));assert.equal(found[0].executionTrust,'untrusted-discovery');
  assert.equal(found[0].mode,'handoff');assert.equal(found[0].ready,false);
});
test('Downloads子根和目录链接按原扫描位置标记，不靠canonical目标推断信任',t=>{
  const home=fixture(t),downloads=path.join(home,'Downloads'),external=path.join(home,'external');fs.mkdirSync(downloads);fs.mkdirSync(external);
  const app=bundle(external,'Gemini'),link=path.join(downloads,'release');fs.symlinkSync(external,link,'junction');
  const metadata=()=>({name:'Gemini',bundleId:'com.google.gemini',version:'1'});
  const options={home,platform:'darwin',env:{},readAppMetadata:metadata};
  const untrusted=discoverApplications({...options,roots:[link]});
  assert.equal(untrusted.length,1);assert.equal(untrusted[0].appPath,fs.realpathSync(app));assert.equal(untrusted[0].executionTrust,'untrusted-discovery');
  const installed=discoverApplications({...options,roots:[external]});
  assert.equal(installed[0].executionTrust,'installed-location');
});

test('Gemini official login configuration changes trigger a rescan without exposing credential content',t=>{
  const home=fixture(t),root=path.join(home,'.gemini');fs.mkdirSync(root);
  const options={home,roots:[],cliRoots:[],platform:process.platform,env:{}};
  const initial=discoveryFingerprint(options);fs.writeFileSync(path.join(root,'settings.json'),'{"security":{"auth":{"selectedType":"oauth-personal"}}}');
  const configured=discoveryFingerprint(options);assert.notEqual(configured,initial);
  fs.writeFileSync(path.join(root,'oauth_creds.json'),'SYNTHETIC_PRIVATE_AUTH');const loggedIn=discoveryFingerprint(options);assert.notEqual(loggedIn,configured);assert(!loggedIn.includes('SYNTHETIC_PRIVATE_AUTH'));
});

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

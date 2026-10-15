'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

// Execute the real renderer and click its real handlers with an in-memory DOM.
// No desktop IPC, authentication, account files or inference is involved.
class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.className='';this.dataset={};this.attributes={};this.handlers={};this._text='';this.disabled=false;}
  append(...nodes){this.children.push(...nodes);}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,handler){this.handlers[name]=handler;}
  get textContent(){return this._text+this.children.map(child=>child.textContent||'').join('');}
  set textContent(value){this._text=String(value);this.children=[];}
  click(){if(!this.disabled)return this.handlers.click?.({preventDefault(){}});}
  remove(){}
}
const walk=node=>[node,...node.children.flatMap(walk)];
const buttons=node=>walk(node).filter(n=>n.tagName==='BUTTON');
function fixture(providers,methods={}){
  const calls=[],roots={toasts:new Element('div')};
  const state={providers,runs:[],telemetry:{}};
  const bridge=new Proxy({}, {get:(_,method)=>async(...args)=>{calls.push({method,args});if(methods[method])return methods[method](...args);if(method==='getState'||method==='refreshProviders')return state;if(method==='testProvider')return {ok:true,modelId:'fixture-model',effort:'low'};if(method==='authenticateProvider')return {started:true};return {};}});
  const document={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),getElementById:id=>roots[id]||(roots[id]=new Element('div'))};
  const context=vm.createContext({window:{agentflow:bridge},document,Intl,Map,Set,Date,performance,console,setTimeout:()=>1,clearTimeout(){}});
  const source=fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8');
  const marker="  $('sidebar-toggle').append";assert(source.includes(marker));
  const body=source.slice(0,source.indexOf(marker))+"render=()=>{};globalThis.ui={connectionState,connectionLabel,renderConnections,authenticate,testConnection,useExistingLogin,acceptState,setState:next=>{state=next;initialized=true;}};})();";
  vm.runInContext(body,context);context.ui.setState(state);
  const render=()=>{const root=new Element('main');context.ui.renderConnections(root);return root;};
  const item=(root,id)=>walk(root).find(n=>n.className.split(' ').includes('provider-'+id));
  const primary=row=>buttons(row.children.find(n=>n.className==='connection-heading')).map(n=>n.textContent||n.attributes['aria-label']);
  return {ui:context.ui,state,calls,roots,render,item,primary};
}
function provider(fields={}){return {id:'codebuddy',name:'CodeBuddy',installed:true,ready:false,mode:'cli',appPath:'/public/CodeBuddy.app',models:[{id:'fixture-model',ready:false}],auth:{kind:'browser-cli',canStart:true,label:'网页登录',state:'unverified',methods:[{id:'internal',label:'微信登录'},{id:'external',label:'国际账号登录'}]},...fields};}

test('连接快照区分已有授权、真正缺登录、待接入和未知，不诱导重复登录',()=>{
  const f=fixture([provider({authStatus:'configured'}),provider({id:'claude',name:'Claude',authenticationState:'required'}),provider({id:'doubao',name:'豆包',mode:'handoff',adapterStatus:'unavailable',auth:{kind:'desktop',canStart:true,state:'unknown'}}),provider({id:'unknown',name:'未知客户端',authStatus:'unknown'})]);
  const root=f.render();
  const snapshot=['codebuddy','claude','doubao','unknown'].map(id=>{const row=f.item(root,id);return {id,status:row.children.find(n=>n.className==='connection-message').textContent,actions:f.primary(row)};});
  assert.deepEqual(snapshot,[
    {id:'codebuddy',status:'待验证',actions:['使用现有登录']},
    {id:'claude',status:'待登录',actions:['微信登录','国际账号登录']},
    {id:'doubao',status:'待接入',actions:['打开原应用']},
    {id:'unknown',status:'待验证',actions:['重新检测']},
  ]);
  const details=f.item(root,'codebuddy').children.find(n=>n.tagName==='DETAILS');
  assert.deepEqual(buttons(details).map(n=>n.textContent),['重新登录 · 微信登录','重新登录 · 国际账号登录']);
  assert(!f.item(root,'doubao').textContent.includes('登录'));
});
test('已有authenticated状态使用现有登录做验证，不调用网页登录',async()=>{
  const p=provider({authenticationState:'authenticated'}),f=fixture([p]);
  const row=f.item(f.render(),p.id),button=buttons(row).find(n=>n.textContent==='使用现有登录');await button.click();
  assert.equal(f.calls.filter(c=>c.method==='testProvider').length,1);assert(!f.calls.some(c=>c.method==='authenticateProvider'));
});
test('Google禁用probe时使用现有登录只刷新检测，即使直接调用testConnection也不发送推理',async()=>{
  const p=provider({id:'gemini',authStatus:'configured',capabilities:{probe:false}}),f=fixture([p]);
  await buttons(f.item(f.render(),p.id)).find(n=>n.textContent==='使用现有登录').click();
  await f.ui.testConnection(p);
  assert.equal(f.calls.filter(c=>c.method==='refreshProviders').length,2);assert(!f.calls.some(c=>['testProvider','authenticateProvider'].includes(c.method)));
});
test('待接入按钮只打开原应用，已配置凭据也不会变成可运行或要求登录',async()=>{
  const p=provider({mode:'handoff',authStatus:'configured',adapterStatus:'unavailable'}),f=fixture([p]);
  const row=f.item(f.render(),p.id);assert.equal(row.dataset.connectionState,'adapter');
  await buttons(row).find(n=>n.textContent==='打开原应用').click();
  assert.deepEqual(f.calls.map(c=>c.method),['openProvider']);
});
test('详情仍保留官方重新登录和原登录地区参数，登录启动后立即刷新',async()=>{
  const p=provider({authStatus:'configured'}),f=fixture([p]);
  const row=f.item(f.render(),p.id);await buttons(row).find(n=>n.textContent==='重新登录 · 国际账号登录').click();
  const call=f.calls.find(c=>c.method==='authenticateProvider');assert.equal(call.args[0],p.id);assert.equal(call.args[1],'external');
  assert(f.calls.some(c=>c.method==='getState'));assert(!f.roots.toasts.textContent.includes('重新检测'));
});
test('授权中可取消且按钮禁用；自动状态刷新后显示已就绪',()=>{
  const p=provider({ready:true,models:[{id:'fixture-model',ready:true}],auth:{kind:'browser-cli',canStart:true,state:'pending',label:'网页登录'}}),f=fixture([p]);
  let row=f.item(f.render(),p.id);assert.equal(f.ui.connectionLabel(p),'授权中');
  assert(buttons(row).some(n=>n.textContent==='取消登录'));assert(buttons(row).find(n=>n.textContent==='网页登录').disabled);
  p.auth.state='verified';f.ui.acceptState(f.state);row=f.item(f.render(),p.id);
  assert.equal(row.children.find(n=>n.className==='connection-message').textContent,'已就绪');assert(!f.primary(row).some(label=>label.includes('登录')));
});
test('明确授权失效优先于旧configured缓存；缺少适配器则始终待接入',()=>{
  const f=fixture([]);
  assert.equal(f.ui.connectionState(provider({authStatus:'configured',authenticationState:'required'})),'required');
  assert.equal(f.ui.connectionState(provider({authStatus:'configured',authenticationState:'required',adapterStatus:'unavailable'})),'adapter');
});
test('官方Terminal登录反馈按实际启动类型提示，不误报已打开浏览器',async()=>{
  for(const descriptor of [{requiresTerminal:true},{}]){
    const p=provider({id:'gemini',auth:{kind:'browser-cli',canStart:true,label:'官方登录',state:'unknown',...descriptor}});
    const f=fixture([p],{authenticateProvider:()=>({started:true,...(!descriptor.requiresTerminal?{kind:'terminal-cli'}:{})})});
    await f.ui.authenticate(p);
    assert.match(f.roots.toasts.textContent,/请在终端完成登录，状态会自动更新/);assert(!f.roots.toasts.textContent.includes('浏览器'));
  }
});

'use strict';
(() => {
  const bridge = window.agentflow;
  const $ = id => document.getElementById(id);
  const icons = {
    layers: ['M3 7l9-5 9 5-9 5-9-5z', 'M3 12l9 5 9-5', 'M3 17l9 5 9-5'],
    history: ['M3 11a9 9 0 1 1 2.6 7', 'M3 4v7h7', 'M12 7v5l3 2'],
    plug: ['M9 3v4', 'M15 3v4', 'M6 7h12v4a6 6 0 0 1-12 0V7z', 'M12 17v4'],
    chart: ['M4 3v17h17', 'M8 15v-4', 'M13 15V7', 'M18 15v-7'],
    plus: ['M12 5v14', 'M5 12h14'],
    arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
    folder: ['M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3V6z'],
    check: ['M5 12l4 4L19 6'],
    checkCircle: ['M21 11v1a9 9 0 1 1-5.3-8.2', 'M21 4l-9 9-3-3'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    info: ['M12 8h.01', 'M12 11v6', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'],
    pause: ['M8 5v14', 'M16 5v14'],
    play: ['M7 4l13 8-13 8V4z'],
    retry: ['M20 8a8 8 0 1 0 0 9', 'M20 3v5h-5'],
    export: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 16v5h16v-5'],
    copy: ['M8 8h12v13H8V8z', 'M16 8V3H3v13h5'],
    external: ['M14 3h7v7', 'M21 3L11 13', 'M10 3H3v18h18v-7'],
    menu: ['M4 5h16v14H4V5z', 'M9 5v14'],
    spark: ['M12 3l2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3z'],
    up: ['M6 15l6-6 6 6'],
    down: ['M6 9l6 6 6-6'],
    grip: ['M9 5h.01', 'M15 5h.01', 'M9 12h.01', 'M15 12h.01', 'M9 19h.01', 'M15 19h.01'],
    trash: ['M3 6h18', 'M8 6V3h8v3', 'M5 6l1 15h12l1-15', 'M10 10v7', 'M14 10v7'],
    terminal: ['M4 4h16v16H4V4z', 'M7 8l4 4-4 4', 'M13 16h4'],
    stop: ['M6 6h12v12H6V6z'],
    clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z', 'M12 7v5l3 2'],
  };

  const labels = {planning:'搭配团队中',awaiting_confirmation:'待确认',queued:'排队中',running:'执行中',cancelling:'取消中',paused:'已暂停',waiting_handoff:'待接入',awaiting_acceptance:'待验收',completed:'已完成',review_failed:'需修改',failed:'失败',cancelled:'已取消',interrupted:'已中断',pending:'等待中',skipped:'已跳过'};
  const roles = {plan:'需求',design:'设计',execute:'执行',review:'验收'};
  const effortNames = {default:'默认强度',none:'关闭',off:'关闭',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'超高'};
  let state={providers:[],runs:[],telemetry:{}};
  let initialized=false, view='chat', selectedThreadId=null, selectedRunId=null, busy=false, compositionActive=false, navigationRevision=0;
  let islandTracking={id:null,status:null}, islandTimer=null, dragState=null, activeSlot=null, dragPointerPending=null, pointerGesture=null;
  let composerEnterHeld=false, composerCompositionEndedAt=-Infinity, selectBlurTimer=null;
  const COMPOSITION_END_GUARD_MS=80;
  const composerDrafts=new Map(), proposalDrafts=new Map(), customModels=new Set(), modelEdits=new Map();
  const expanded=new Set(), handoffs=new Map(), handoffResults=new Map(), providerTests=new Map(), feedbacks=new Map();
  const scrollPositions=new Map();
  const usageView={scope:'software',model:'',metric:'input',type:'line',distributionMetric:'tokens',replay:0};
  const charts=window.AgentFlowUsage;
  const fmt=new Intl.NumberFormat('zh-CN');
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=String(text);return n;};
  const append=(parent,...children)=>{children.filter(Boolean).forEach(c=>parent.append(c));return parent;};
  function icon(name){const n=document.createElementNS('http://www.w3.org/2000/svg','svg');n.setAttribute('viewBox','0 0 24 24');n.setAttribute('aria-hidden','true');(icons[name]||icons.info).forEach(d=>{const p=document.createElementNS(n.namespaceURI,'path');p.setAttribute('d',d);n.append(p);});return n;}
  function button(text,cls,image,handler){const n=el('button',cls);n.type='button';if(image)n.append(icon(image));if(text)n.append(el('span','',text));if(handler)n.addEventListener('click',handler);return n;}
  function iconButton(title,image,handler){const n=button('','icon-button',image,handler);n.title=title;n.setAttribute('aria-label',title);return n;}
  const clone=x=>JSON.parse(JSON.stringify(x));
  const providers=()=>Array.isArray(state.providers)?state.providers:[];
  const runs=()=>Array.isArray(state.runs)?state.runs:[];
  const providerById=id=>providers().find(p=>p.id===id);
  const pname=p=>p?.id==='doubao'?(p.name?.includes('豆')?p.name:'豆包 / Doubao'):p?.name||p?.id||'—';
  const pclass=id=>'provider-'+String(id||'').toLowerCase().replace(/[^a-z0-9_-]/g,'');
  const threadId=r=>r?.threadId||r?.id;
  const currentThreadRuns=()=>runs().filter(r=>threadId(r)===selectedThreadId).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  const currentRun=()=>runs().find(r=>r.id===selectedRunId)||currentThreadRuns().at(-1)||null;
  const isLive=r=>r&&['planning','awaiting_confirmation','queued','running','cancelling','paused','waiting_handoff','awaiting_acceptance'].includes(r.status);
  const activeStage=r=>r?.stages?.find(s=>['running','waiting_handoff'].includes(s.status));
  const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const metric=v=>numeric(v)?fmt.format(v):'—';
  const money=v=>numeric(v)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:5}).format(v):'—';
  const partial=u=>u?.partial===true||(Array.isArray(u?.partialFields)&&u.partialFields.length>0);
  const rawError=e=>String(e?.message||(typeof e==='string'?e:'操作失败'));
  function errorText(error){let message=rawError(error);for(let i=0;i<3;i++)message=message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i,'').replace(/^Error:\s*/i,'');if(/auth(?:entication)?[\s_-]*required|not authenticated|login required|please (?:log|sign) in|session expired|authorization expired/i.test(message))return'登录尚未完成，请重新授权';if(message.length>140||message.includes('\n'))return'操作未完成，请查看详情';return message||'操作失败';}
  function errorDetails(error){const details=el('details','error-details');append(details,el('summary','','详情'),el('pre','output-text',rawError(error)));return details;}
  function errorBlock(error){const block=append(el('div','error-block'),el('p','stage-error',errorText(error)));if(rawError(error)!==errorText(error))block.append(errorDetails(error));return block;}
  function showError(error){toast(errorText(error),true,rawError(error));}
  function providerAuth(provider){const kind=provider?.auth?.kind;if(!['browser-cli','desktop'].includes(kind))return null;const opensApp=kind==='desktop'&&(provider.mode==='handoff'||provider.authStatus==='client-managed'&&provider.adapterStatus==='unavailable');return {kind,opensApp,pending:provider.auth.state==='pending',label:opensApp?'打开原应用':provider.auth.label||(kind==='browser-cli'?'网页登录':'打开'+pname(provider).split(' / ')[0]+'登录'),methods:!opensApp&&Array.isArray(provider.auth.methods)?provider.auth.methods.filter(method=>typeof method.id==='string'&&typeof method.label==='string'):[]};}
  async function authenticate(provider,methodId){const auth=providerAuth(provider);if(!auth)return;if(auth.opensApp){await action(()=>call('openProvider',provider.id));return;}await action(async()=>{const result=methodId===undefined?await call('authenticateProvider',provider.id):await call('authenticateProvider',provider.id,methodId);if(result?.started!==true)throw new Error('登录未启动');toast(auth.kind==='browser-cli'?'登录已启动，请在浏览器完成授权，然后重新检测。':'已打开'+pname(provider).split(' / ')[0]+'，请在原应用完成登录。');});}
  async function cancelAuthentication(provider){await action(async()=>{const result=await call('cancelAuthentication',provider.id);await refresh();toast(result?.cancelled===false?'登录流程已结束':'已取消登录');});}
  function appendAuthActions(parent,provider,cls){const auth=providerAuth(provider);if(!auth)return;(auth.methods.length?auth.methods:[{label:auth.label}]).forEach(method=>{const login=button(method.label,cls,'external',()=>authenticate(provider,method.id));login.disabled=busy||auth.pending;parent.append(login);});if(auth.pending){const cancel=button('取消登录',cls,'close',()=>cancelAuthentication(provider));cancel.disabled=busy;parent.append(cancel);}}
  function time(value,date=false){const d=new Date(value);if(!value||!Number.isFinite(d.getTime()))return'—';return new Intl.DateTimeFormat('zh-CN',date?{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}:{hour:'2-digit',minute:'2-digit',hour12:false}).format(d);}
  function statusBadge(status){return el('span','state-badge '+(status||'pending'),labels[status]||status||'—');}
  function toast(message,error=false,detail=''){const content=append(el('div','toast-content'),el('span','',message));if(error&&detail&&detail!==message)content.append(errorDetails(detail));const n=append(el('div','toast'+(error?' error':'')),icon(error?'info':'check'),content);n.append(iconButton('关闭','close',()=>n.remove()));$('toasts').append(n);if(!error)setTimeout(()=>n.remove(),4500);}
  async function call(method,...args){if(typeof bridge?.[method]!=='function')throw new Error('请从桌面应用打开，或更新至当前版本。');return bridge[method](...args);}
  async function refresh(){const next=await call('getState');acceptState(next);return next;}
  async function action(task){if(busy)return;busy=true;render();try{await task();}catch(e){showError(e);}finally{busy=false;render();}}
  function baseDraft(){const c=state.config||{};return {prompt:'',workspace:c.workspace||'',starter:clone(c.starter||{provider:'codex',model:'',effort:'default'})};}
  function draft(){const key=selectedThreadId||'new';if(!composerDrafts.has(key)){const d=baseDraft();const latest=currentThreadRuns().at(-1);if(latest?.workspace)d.workspace=latest.workspace;if(latest?.starter)d.starter={provider:latest.starter.provider,model:latest.starter.model||'',effort:latest.starter.effort||'default'};composerDrafts.set(key,d);}return composerDrafts.get(key);}
  function providerReady(provider){return Boolean(provider?.ready&&['cli','api'].includes(provider.mode)&&provider.models?.some(model=>typeof model==='object'&&model.ready===true&&model.availability!=='unavailable'));}
  function modelReady(provider,id){if(!providerReady(provider))return false;if(!id)return provider.models.some(model=>model.ready===true&&model.availability!=='unavailable');const model=provider.models.find(model=>model.id===id);return model?.ready===true&&model.availability!=='unavailable';}
  function readyProviders(){return providers().filter(providerReady);}
  function stageModel(stage){return typeof stage?.model==='string'&&stage.model&&stage.model!=='default'?stage.model:'默认未回报';}
  function loggedModels(provider){return Array.isArray(provider?.models)?provider.models.filter(model=>typeof model==='object'&&typeof model.id==='string'):[];}
  function efforts(provider,modelId){const m=provider?.models?.find(m=>typeof m==='object'&&m.id===(modelId||'default'));const values=Array.isArray(m?.efforts)&&m.efforts.length?m.efforts:['default'];return [...new Set(['default',...values])];}
  function modelLabel(m,provider){if(typeof m==='string')return m;const names={'codex-model-cache':'Codex 目录','dsh-bundled-catalog':'DSH 内置','dsh-headless-default':'DSH 默认','client-model-config':'客户端','cli-config':'CLI 配置','not-exposed':'客户端'};const source=typeof m.source==='string'?m.source:m.source?.kind==='connector-catalog'?(m.providerRoute||m.source.provider||'外接目录')+(m.source.profile?' / '+m.source.profile:''):names[m.source?.kind]||pname(provider);return(m.label||m.id)+(source?' · '+source:'')+(m.ready===false?' · 未就绪':'');}
  function acceptState(next){if(!next||typeof next!=='object')throw new Error('本机状态无效');state=next;if(state.telemetry?.tokenlens?.softwareSamplesSupported===false&&usageView.scope==='software'){usageView.scope='task';usageView.model='';}if(!initialized){initialized=true;const active=(next.activeRunIds||[next.activeRunId]).filter(Boolean)[0];if(!next.initializing&&active&&navigationRevision===0){const r=runs().find(r=>r.id===active);selectedRunId=r?.id||null;selectedThreadId=threadId(r)||null;}}render();}
  function chooseThread(id){navigationRevision++;clearDrag();view='chat';selectedThreadId=id;selectedRunId=currentThreadRuns().at(-1)?.id||null;render({force:true,navigation:true});}
  function newTask(){navigationRevision++;view='chat';selectedThreadId=null;selectedRunId=null;composerDrafts.set('new',baseDraft());clearDrag();render({force:true,navigation:true});setTimeout(()=>$('composer-prompt')?.focus(),0);}
  function navigate(next){navigationRevision++;if(next==='usage')usageView.replay++;view=next;clearDrag();render({force:true,navigation:true});}
  function animateSurface(node){if(node&&!matchMedia('(prefers-reduced-motion: reduce)').matches)node.animate([{opacity:.45,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:200,easing:'cubic-bezier(.22,1,.36,1)'});}
  function showDialog(dialog){dialog.showModal();animateSurface(dialog);}
  function preserveFocus(fn){const focused=document.activeElement,key=focused?.dataset?.focusId;let selection=null;try{if(typeof focused.selectionStart==='number')selection=[focused.selectionStart,focused.selectionEnd];}catch{}fn();if(key){const next=Array.from(document.querySelectorAll('[data-focus-id]')).find(n=>n.dataset.focusId===key);if(next){next.focus({preventScroll:true});if(selection)try{next.setSelectionRange(...selection);}catch{}}}}
  function render(options={}){
    const focused=document.activeElement;
    // Preserve a native drag source from pointerdown, before HTML5 dragstart.
    if((dragPointerPending&&!options.navigation)||(!options.force&&(compositionActive||dragState))){renderSidebar();renderIsland();renderInspector();return;}
    if(!options.force&&focused?.tagName==='SELECT'&&focused.dataset.focusId&&!focused.disabled){const row=focused.closest('.workflow-stage'),next=runs().find(r=>r.id===row?.dataset.runId)?.stages?.find(s=>s.id===row?.dataset.stageId);if(!next||!['running','completed','skipped'].includes(next.status)){renderSidebar();renderIsland();renderInspector();return;}}
    const old=document.querySelector('.conversation-scroll');if(old)scrollPositions.set(old.dataset.threadId,{top:old.scrollTop,bottom:old.scrollHeight-old.scrollTop-old.clientHeight<70});
    const rects=options.flip?new Map(Array.from(document.querySelectorAll('.workflow-stage')).map(n=>[n.dataset.runId+':'+n.dataset.stageId,n.getBoundingClientRect()])):null;
    preserveFocus(()=>{renderSidebar();renderIsland();const main=$('main-content');main.replaceChildren();main.classList.toggle('utility-view',view!=='chat');if(!bridge)main.append(append(el('section','no-bridge'),icon('terminal'),el('h1','','请从桌面应用打开')));else if(!initialized||state.initializing)main.append(el('div','empty-chat',state.initializing?'检测智能体…':'连接中…'));else if(view==='connections')renderConnections(main);else if(view==='usage')renderUsage(main);else renderChat(main);renderInspector();});
    const scroll=document.querySelector('.conversation-scroll');if(scroll){const saved=scrollPositions.get(scroll.dataset.threadId);scroll.scrollTop=saved&&!saved.bottom?saved.top:scroll.scrollHeight;}
    if(options.navigation)animateSurface($('main-content').firstElementChild);
    if(rects&&!matchMedia('(prefers-reduced-motion: reduce)').matches){document.querySelectorAll('.workflow-stage').forEach(n=>{const before=rects.get(n.dataset.runId+':'+n.dataset.stageId);if(!before)return;const after=n.getBoundingClientRect();const dx=before.x-after.x,dy=before.y-after.y;if(dx||dy)n.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'translate(0,0)'}],{duration:210,easing:'cubic-bezier(.22,1,.36,1)'});});}
  }
  function renderSidebar(){
    const groups=new Map();runs().forEach(r=>{const id=threadId(r);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(r);});
    const list=$('conversation-list');list.replaceChildren();
    [...groups].map(([id,items])=>({id,items:items.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt))})).sort((a,b)=>new Date(b.items.at(-1).createdAt)-new Date(a.items.at(-1).createdAt)).forEach(({id,items})=>{
      const last=items.at(-1),first=items[0],title=last.title||first.title||first.prompt||'未命名任务';
      const row=el('div','thread-row'),n=button('','thread-item'+(view==='chat'&&selectedThreadId===id?' active':''),null,()=>chooseThread(id));
      n.title=title;n.setAttribute('aria-label',title);if(view==='chat'&&selectedThreadId===id)n.setAttribute('aria-current','page');
      append(n,el('span','thread-title',title),append(el('span','thread-meta'),el('span','thread-state '+last.status,labels[last.status]||last.status),el('span','',time(last.createdAt))));
      const remove=iconButton('删除聊天 '+title,'trash',()=>deleteThread(id,title));remove.classList.add('thread-delete');remove.disabled=busy;append(row,n,remove);list.append(row);
    });
    const nav=$('navigation');nav.replaceChildren();[['connections','连接','plug'],['usage','用量','chart']].forEach(([id,title,img])=>{const n=button(title,'nav-item'+(view===id?' active':''),img,()=>navigate(id));n.title=title;n.setAttribute('aria-label',title);n.querySelector('span')?.classList.add('nav-label');nav.append(n);});
    $('new-task').disabled=!bridge;$('app-version').textContent=state.version?'AgentFlow '+state.version:'AgentFlow';
    const selected=currentThreadRuns().at(-1);$('page-crumb').textContent=view==='connections'?'连接':view==='usage'?'用量':selected?.title||selected?.prompt?.slice(0,30)||'新任务';
    const active=runs().filter(r=>['planning','queued','running'].includes(r.status)).length;$('task-count').textContent=active?active+' 个进行中':'';
  }
  async function deleteThread(id,title){
    if(!await confirmAction('删除聊天？','聊天记录移到回收站，项目产物保留。','删除'))return;
    await action(async()=>{const removed=runs().filter(r=>threadId(r)===id).map(r=>r.id);const result=await call('deleteThread',{threadId:id});composerDrafts.delete(id);removed.forEach(runId=>{proposalDrafts.delete(runId);feedbacks.delete(runId);for(const key of handoffs.keys())if(key.startsWith(runId+':'))handoffs.delete(key);for(const key of handoffResults.keys())if(key.startsWith(runId+':'))handoffResults.delete(key);});if(selectedThreadId===id){selectedThreadId=null;selectedRunId=null;view='chat';navigationRevision++;}if(result?.runs)acceptState(result);else await refresh();toast('已删除');});
  }
  function renderIsland(){
    const ids=state.activeRunIds||[state.activeRunId];const r=currentRun()||runs().find(r=>ids.includes(r.id)&&isLive(r));
    const s=r?.status==='planning'?r.starter:activeStage(r)||[...(r?.stages||[])].reverse().find(s=>['failed','cancelled','completed'].includes(s.status));
    const island=$('island'),same=Boolean(r?.id&&islandTracking.id===r.id),completed=same&&islandTracking.status&&islandTracking.status!=='completed'&&r.status==='completed';
    if(!same){island.classList.remove('island-completing');clearTimeout(islandTimer);}island.dataset.state=state.initializing?'initializing':r?.status||'idle';island.dataset.provider=s?.provider||'codex';
    if(completed){island.classList.add('island-completing');clearTimeout(islandTimer);islandTimer=setTimeout(()=>island.classList.remove('island-completing'),1950);}islandTracking={id:r?.id||null,status:r?.status||null};
    $('island-label').textContent=!bridge?'未连接':state.initializing?'检测智能体…':!initialized?'连接中…':r?(r.status==='running'&&s?pname(providerById(s.provider)||{id:s.provider})+' · '+(roles[s.role]||s.name):labels[r.status]||r.status):'准备就绪';
  }
  function renderChat(main){
    const layout=el('section','chat-layout'),scroll=el('div','conversation-scroll');scroll.dataset.threadId=selectedThreadId||'new';
    const items=currentThreadRuns();if(!items.length)scroll.append(append(el('div','empty-chat'),el('h1','','新任务')));else items.forEach(r=>scroll.append(runMessage(r)));
    append(layout,scroll,renderComposer());main.append(layout);
  }
  function renderComposer(){
    const d=draft(),zone=el('section','composer-zone');
    const input=el('textarea');input.id='composer-prompt';input.placeholder='输入需求…';input.value=d.prompt;input.rows=2;input.maxLength=32000;input.dataset.focusId='composer-prompt';input.setAttribute('aria-label','任务需求');input.addEventListener('input',()=>{d.prompt=input.value;const send=$('composer-send');if(send)send.disabled=busy||!d.prompt.trim()||!modelReady(providerById(d.starter.provider),d.starter.model);});
    input.addEventListener('keydown',handleComposerKeydown);
    const toolbar=el('div','composer-toolbar'),starter=el('div','starter-picker');starter.title='启动模型：先搭配团队，确认后执行';
    appendSelection(starter,d.starter,'starter',patch=>{Object.assign(d.starter,patch);render({force:true});},{onlyReady:true,compact:true});
    const workspace=button('','composer-folder','folder',()=>chooseWorkspace());workspace.title=d.workspace||'选择工作目录；未选择时由应用创建独立目录';workspace.setAttribute('aria-label','选择工作目录');workspace.append(el('span','workspace-chip',d.workspace?d.workspace.split('/').filter(Boolean).at(-1):'独立目录'));
    const send=iconButton('搭配团队','arrow',sendRequest);send.id='composer-send';send.title='Enter 发送 · Shift+Enter 换行';send.classList.add('composer-send','primary-button');send.disabled=busy||!d.prompt.trim()||!modelReady(providerById(d.starter.provider),d.starter.model);
    append(toolbar,starter,workspace,send);zone.append(append(el('div','composer-input'),input,toolbar));return zone;
  }
  function handleComposerKeydown(event){
    if(event.key!=='Enter')return;
    // IME confirmation is text input, including Chromium's 229 legacy code.
    if(event.isComposing||compositionActive||event.keyCode===229||event.which===229){composerEnterHeld=true;return;}
    if(event.shiftKey)return;
    event.preventDefault();
    // WebKit may finish composition before its confirmation Enter keydown.
    if(event.repeat||composerEnterHeld||performance.now()-composerCompositionEndedAt<COMPOSITION_END_GUARD_MS)return;
    composerEnterHeld=true;
    if(busy||$('composer-send')?.disabled)return;
    sendRequest();
  }
  async function chooseWorkspace(){const target=draft();await action(async()=>{const chosen=await call('chooseWorkspace');if(chosen)target.workspace=chosen;});}
  async function sendRequest(){await action(async()=>{const d=draft();if(!d.prompt.trim())throw new Error('请填写需求');if(!modelReady(providerById(d.starter.provider),d.starter.model))throw new Error('请选择已就绪的启动模型');const revision=navigationRevision;const config={prompt:d.prompt.trim(),workspace:d.workspace||'',starter:clone(d.starter)};if(selectedThreadId)config.threadId=selectedThreadId;const r=await call('proposeWorkflow',config);if(!r?.id)throw new Error('未收到任务');if(d.prompt.trim()===config.prompt)d.prompt='';const id=threadId(r);composerDrafts.set(id,{prompt:'',workspace:r.workspace||d.workspace,starter:clone(d.starter)});if(navigationRevision===revision){selectedThreadId=id;selectedRunId=r.id;view='chat';}await refresh();});}
  function appendSelection(parent,selection,key,onChange,{disabled=false,onlyReady=true,compact=false}={}){
    const provider=providerById(selection.provider),ps=providers();
    const p=el('select');p.setAttribute('aria-label',compact?'启动智能体':'智能体');p.title=compact?'启动智能体':'智能体';p.classList.toggle('selection-unavailable',onlyReady&&!providerReady(provider));p.dataset.focusId=key+'-provider';p.disabled=disabled;
    ps.forEach(item=>{const o=el('option','',pname(item)+(!providerReady(item)?(item.mode==='handoff'?' · 待接入':' · 未就绪'):''));o.value=item.id;o.selected=item.id===selection.provider;o.disabled=onlyReady&&!providerReady(item);p.append(o);});
    if(!ps.some(item=>item.id===selection.provider)){const o=el('option','',pname(provider||{id:selection.provider})+' · 未就绪');o.value=selection.provider||'';o.selected=true;o.disabled=onlyReady;p.append(o);}
    p.addEventListener('change',()=>{customModels.delete(key);modelEdits.delete(key);onChange({provider:p.value,model:'',effort:'default'});});
    const options=provider?.models||[],known=options.some(m=>(typeof m==='string'?m:m.id)===selection.model);
    let model;
    if(!onlyReady&&(customModels.has(key)||(selection.model&&!known))){
      model=el('input');model.type='text';model.value=modelEdits.get(key)??selection.model??'';model.placeholder='模型 ID';model.maxLength=160;model.addEventListener('input',()=>modelEdits.set(key,model.value));model.addEventListener('change',()=>{const id=model.value.trim(),allowed=efforts(provider,id);modelEdits.delete(key);onChange({model:id,effort:allowed.includes(selection.effort)?selection.effort:'default'});});model.addEventListener('keydown',e=>{if(e.key==='Escape'){customModels.delete(key);modelEdits.delete(key);onChange({model:'',effort:'default'});}});
    }else{
      model=el('select');const def=el('option','','默认模型');def.value='';def.selected=!selection.model;def.disabled=onlyReady&&!providerReady(provider);model.append(def);if(selection.model&&!known){const old=el('option','',selection.model+' · 未就绪');old.value=selection.model;old.selected=true;old.disabled=true;model.append(old);}
      options.forEach(m=>{const id=typeof m==='string'?m:m.id;if(typeof id!=='string'||!id)return;const o=el('option','',modelLabel(m,provider));o.value=id;o.selected=id===selection.model;o.disabled=onlyReady&&!modelReady(provider,id);model.append(o);});
      const custom=el('option','','自定义模型…');custom.value='__custom_model__';if(!onlyReady)model.append(custom);model.addEventListener('change',()=>{if(model.value==='__custom_model__'){customModels.add(key);render({force:true});setTimeout(()=>document.querySelector('[data-focus-id="'+key+'-model"]')?.focus(),0);return;}const allowed=efforts(provider,model.value);onChange({model:model.value,effort:allowed.includes(selection.effort)?selection.effort:'default'});});
    }
    model.dataset.focusId=key+'-model';model.setAttribute('aria-label',compact?'启动模型':'模型');model.title=compact?'启动模型':'模型';model.classList.toggle('selection-unavailable',onlyReady&&!modelReady(provider,selection.model));model.disabled=disabled;
    const effort=el('select');effort.dataset.focusId=key+'-effort';effort.setAttribute('aria-label',compact?'启动思考强度':'思考强度');effort.title='思考强度';effort.disabled=disabled;efforts(provider,selection.model).forEach(value=>{const o=el('option','',effortNames[value]||value);o.value=value;o.selected=value===(selection.effort||'default');effort.append(o);});effort.addEventListener('change',()=>onChange({effort:effort.value}));
    append(parent,append(el('label','field'),p),append(el('label','field'),model),append(el('label','field'),effort));
  }
  function runMessage(run){
    const article=el('article','run-message');article.dataset.runId=run.id;
    append(article,append(el('div','user-message'),el('p','user-request',run.prompt||'—')));
    const top=append(el('div','run-top'),el('h2','run-title',run.title||run.proposal?.title||'任务'),statusBadge(run.status));if(run.starter)top.append(conversationButton(run,run.starter,'启动模型对话'));top.append(iconButton('导出任务','export',()=>exportRun(run)));article.append(top);
    if(run.starter?.text){const details=el('details','starter-output');details.open=expanded.has('starter:'+run.id);details.addEventListener('toggle',()=>details.open?expanded.add('starter:'+run.id):expanded.delete('starter:'+run.id));append(details,el('summary','',run.status==='planning'?'搭配团队中…':pname(providerById(run.starter.provider)||{id:run.starter.provider})),el('pre','output-text',run.starter.text));article.append(details);}
    if(run.starter?.error)article.append(errorBlock(run.starter.error));
    if(run.error)article.append(errorBlock(run.error));
    if(run.status==='planning')article.append(el('div','proposal-status','搭配团队中…'));
    if(run.stages?.length){const editor=el('section','flow-editor');editor.dataset.runId=run.id;const stages=run.status==='awaiting_confirmation'?editableStages(run):run.stages;const stack=el('div','workflow-stack');
      stages.forEach((stage,i)=>{if(run.status==='awaiting_confirmation'&&i>0)stack.append(dropSlot(run,i));stack.append(stageNode(run,stage,i,stages));});
      stack.addEventListener('dragover',event=>handleDragOver(event,run));stack.addEventListener('drop',event=>handleDrop(event,run));append(editor,stack);
      if(run.status==='awaiting_confirmation'){editor.append(agentDock(run));const actions=append(el('div','workflow-actions'),button('确认团队并执行','primary-button','play',()=>confirmWorkflow(run)));actions.firstChild.disabled=busy||!stages.every(stage=>modelReady(providerById(stage.provider),stage.model));if(actions.firstChild.disabled&&!busy)actions.firstChild.title='请替换未就绪的智能体或模型';append(actions,iconButton('更换工作目录','folder',()=>chooseRunWorkspace(run)));editor.append(actions);}
      article.append(editor);
    }
    renderRunControls(article,run);
    if(run.finalText)article.append(el('pre','output-text final-result',run.finalText));if(run.humanDecision?.feedback)article.append(append(el('div','user-message'),el('p','user-request',run.humanDecision.feedback)));
    if(run.status==='awaiting_acceptance')article.append(acceptancePanel(run));
    if(run.status==='completed'&&run.finalText)article.append(button('复制结果','quiet-button compact','copy',()=>copyText(run.finalText,'已复制')));
    return article;
  }
  function editableStages(run){if(!proposalDrafts.has(run.id))proposalDrafts.set(run.id,clone(run.stages||[]).filter(s=>s.enabled!==false));return proposalDrafts.get(run.id);}
  function stageNode(run,stage,index,stages){
    const editing=run.status==='awaiting_confirmation',middle=index>0&&index<stages.length-1;
    const pending=!editing&&['pending','failed','cancelled','waiting_handoff'].includes(stage.status)&&!['completed','cancelling','planning','awaiting_acceptance'].includes(run.status);
    const node=el('section','workflow-stage '+pclass(stage.provider)+((editing||pending)&&!modelReady(providerById(stage.provider),stage.model)?' unavailable':''));node.dataset.stageId=stage.id;node.dataset.runId=run.id;node.dataset.provider=stage.provider;node.dataset.status=stage.status||'pending';
    const number=el('span','stage-number',stage.status==='completed'?'':String(index+1).padStart(2,'0'));if(stage.status==='completed')number.append(icon('check'));const track=append(el('div','stage-track'),number);
    const body=el('div','stage-body'),head=el('div','stage-head');append(head,el('span','provider-marker'),el('h3','stage-role',index===0?'需求':index===stages.length-1?'验收':stage.name||roles[stage.role]||'执行'));
    if(stage.status&&run.status!=='awaiting_confirmation')head.append(el('span','stage-status',labels[stage.status]||stage.status));
    if(editing&&middle){const grip=iconButton('拖动排序；Alt+上下键移动，Delete 移除','grip');grip.classList.add('stage-grip');grip.dataset.focusId=run.id+'-'+stage.id+'-grip';grip.draggable=true;grip.addEventListener('dragstart',e=>startDrag(e,{type:'stage',runId:run.id,stageId:stage.id}));grip.addEventListener('dragend',clearDrag);grip.addEventListener('keydown',e=>{if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();moveStage(run,stage.id,e.key==='ArrowUp'?-1:1);}else if(['Delete','Backspace'].includes(e.key)){e.preventDefault();removeStage(run,stage.id);}});head.append(grip);}
    const selectors=el('div','stage-selectors');appendSelection(selectors,stage,run.id+'-'+stage.id,patch=>{if(editing){Object.assign(stage,patch);render({force:true});}else action(async()=>{await call('updateStage',{runId:run.id,stageId:stage.id,provider:patch.provider??stage.provider,model:patch.model??stage.model??'',effort:patch.effort??stage.effort??'default'});handoffs.delete(run.id+':'+stage.id);await refresh();});},{disabled:busy||(!editing&&!pending)});
    append(body,head,selectors);
    const conversation=conversationButton(run,stage,(stage.name||roles[stage.role]||'环节')+'对话');conversation.classList.add('stage-conversation');body.append(conversation);
    if(stage.error)body.append(errorBlock(stage.error));
    if(stage.text){const key=run.id+':'+stage.id,details=el('details','stage-result');details.open=expanded.has(key);details.addEventListener('toggle',()=>details.open?expanded.add(key):expanded.delete(key));append(details,el('summary','','输出'),el('pre','output-text',stage.text));body.append(details);}
    if(stage.status==='waiting_handoff')body.append(button('连接','quiet-button compact','plug',()=>navigate('connections')));
    append(node,track,body);return node;
  }
  function dropSlot(run,index){const slot=el('div','drop-slot');slot.dataset.runId=run.id;slot.dataset.insertIndex=index;slot.append(el('span','drop-preview'));return slot;}
  function agentDock(run){
    const dock=el('div','agent-dock');dock.setAttribute('aria-label','可添加的智能体');
    providers().forEach(provider=>{
      const ready=providerReady(provider)&&provider.auth?.state!=='pending',tile=el('div','dock-agent agent-card '+pclass(provider.id)+(ready?' ready':' unavailable'));tile.dataset.provider=provider.id;tile.title=ready?'拖近流程卡片插入；Enter 添加':provider.mode==='handoff'?'缺少自动连接入口，请查看连接详情':'请先登录或验证连接';tile.draggable=ready&&!busy;
      append(tile,append(el('div','agent-card-title'),el('span','provider-marker'),el('span','',pname(provider))),el('span','agent-card-state',provider.auth?.state==='pending'?'授权中':ready?'已就绪':provider.mode==='handoff'?'待接入':'未就绪'));
      if(ready){tile.dataset.focusId=run.id+'-dock-'+provider.id;tile.tabIndex=0;tile.setAttribute('role','button');tile.setAttribute('aria-label','添加 '+pname(provider));tile.addEventListener('dragstart',event=>startDrag(event,{type:'provider',runId:run.id,providerId:provider.id}));tile.addEventListener('dragend',clearDrag);tile.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();insertProvider(run,provider.id,editableStages(run).length-1);}});}
      else{tile.setAttribute('role','group');tile.setAttribute('aria-label',pname(provider)+(provider.mode==='handoff'?' 待接入':' 未就绪'));const auth=providerAuth(provider),verify=!auth&&provider.id==='workbuddy'&&provider.mode==='cli';if(auth){appendAuthActions(tile,provider,'quiet-button compact');}else{const connect=button(verify?'验证连接':'连接','quiet-button compact','plug',()=>verify?testConnection(provider):navigate('connections'));if(verify)connect.title='真实验证会消耗少量用量';connect.disabled=busy;tile.append(connect);}}
      dock.append(tile);
    });
    const del=append(el('div','delete-zone'),icon('trash'),el('span','','移除节点'));del.dataset.runId=run.id;del.title='将中间节点拖到这里移除';del.setAttribute('aria-label','移除节点');
    del.addEventListener('dragover',event=>{if(dragState?.type==='stage'&&dragState.runId===run.id){event.preventDefault();event.dataTransfer.dropEffect='move';del.classList.add('drag-over');}});del.addEventListener('dragleave',()=>del.classList.remove('drag-over'));del.addEventListener('drop',event=>{event.preventDefault();if(dragState?.type==='stage'&&dragState.runId===run.id)removeStage(run,dragState.stageId);clearDrag();});dock.append(del);return dock;
  }
  function startDrag(event,payload){if(payload.type==='provider'&&!providerReady(providerById(payload.providerId))){event.preventDefault();dragPointerPending=null;return;}document.querySelectorAll('.workflow-stage').forEach(n=>n.getAnimations().forEach(animation=>animation.finish()));dragState=payload;dragPointerPending=null;activeSlot=null;event.dataTransfer.effectAllowed=payload.type==='provider'?'copy':'move';event.dataTransfer.setData('application/x-agentflow',JSON.stringify(payload));event.dataTransfer.setData('text/plain',payload.stageId||payload.providerId);document.body.classList.add('drag-in-progress');if(payload.type==='stage')event.target.closest('.workflow-stage')?.classList.add('dragging');document.querySelectorAll('.delete-zone').forEach(n=>n.classList.toggle('active',payload.type==='stage'&&n.dataset.runId===payload.runId));}
  function clearDrag(){const gesture=pointerGesture;pointerGesture=null;if(gesture){cancelAnimationFrame(gesture.frame);gesture.ghost?.remove();try{if(gesture.source.hasPointerCapture(gesture.id))gesture.source.releasePointerCapture(gesture.id);}catch{}}dragState=null;dragPointerPending=null;activeSlot=null;document.body.classList.remove('drag-in-progress','pointer-drag-in-progress');document.querySelectorAll('.drop-slot.active,.dragging,.delete-zone.drag-over,.delete-zone.active,.pointer-drag-source').forEach(n=>n.classList.remove('active','dragging','drag-over','pointer-drag-source'));}
  function releaseDragPointer(){if(pointerGesture){clearDrag();render({force:true});return;}if(!dragPointerPending)return;dragPointerPending=null;setTimeout(()=>render(),0);}
  function updateSnap(stack,run,x,y){
    const slots=Array.from(stack.querySelectorAll('.drop-slot')),cards=Array.from(stack.querySelectorAll('.workflow-stage'));let nearest=null,best=Infinity;
    const held=slots.find(slot=>slot.classList.contains('active'));
    if(held){const rect=held.getBoundingClientRect();if(x>=rect.left-54&&x<=rect.right+54&&y>=rect.top&&y<=rect.bottom)nearest=held;}
    if(!nearest)cards.forEach((card,index)=>{const rect=(card.querySelector('.stage-body')||card).getBoundingClientRect(),dx=Math.max(rect.left-x,0,x-rect.right),dy=Math.max(rect.top-y,0,y-rect.bottom);if(dx>54||dy>54)return;const insertion=Math.max(1,Math.min(cards.length-1,y<rect.top+rect.height/2?index:index+1));const slot=slots.find(slot=>Number(slot.dataset.insertIndex)===insertion),score=dx+dy;if(slot&&score<best){nearest=slot;best=score;}});
    activeSlot=nearest?{runId:run.id,index:Number(nearest.dataset.insertIndex)}:null;
    slots.forEach(slot=>{slot.classList.toggle('active',slot===nearest);const preview=slot.querySelector('.drop-preview');if(preview)preview.textContent=slot===nearest?(dragState.type==='provider'?pname(providerById(dragState.providerId)):'移动到此处'):'';});
    return nearest;
  }
  function handleDragOver(event,run){if(!dragState||dragState.runId!==run.id||run.status!=='awaiting_confirmation')return;if(updateSnap(event.currentTarget,run,event.clientX,event.clientY)){event.preventDefault();event.dataTransfer.dropEffect=dragState.type==='provider'?'copy':'move';}}
  function beginPointerDrag(event){
    if(event.button!==0||event.isPrimary===false||busy||pointerGesture)return;
    const source=event.target?.closest?.('.dock-agent[draggable="true"],.stage-grip[draggable="true"]');if(!source)return;
    const editor=source.closest('.flow-editor'),run=runs().find(run=>run.id===editor?.dataset.runId);if(!run||run.status!=='awaiting_confirmation')return;
    const stage=source.closest('.workflow-stage'),payload=stage?{type:'stage',runId:run.id,stageId:stage.dataset.stageId}:{type:'provider',runId:run.id,providerId:source.dataset.provider};
    if(payload.type==='provider'&&!providerReady(providerById(payload.providerId)))return;
    event.preventDefault();clearTimeout(selectBlurTimer);dragPointerPending=source;
    pointerGesture={id:event.pointerId,source,payload,runId:run.id,x:event.clientX,y:event.clientY,originX:event.clientX,originY:event.clientY,started:false,ghost:null,deleteTarget:null,frame:0};
    source.focus({preventScroll:true});try{source.setPointerCapture(event.pointerId);}catch{}
  }
  function pointerDragTarget(gesture){
    const run=runs().find(run=>run.id===gesture.runId),editor=Array.from(document.querySelectorAll('.flow-editor')).find(node=>node.dataset.runId===gesture.runId);if(!editor||run?.status!=='awaiting_confirmation'){activeSlot=null;return;}
    const stack=editor.querySelector('.workflow-stack'),zone=editor.querySelector('.delete-zone'),rect=zone?.getBoundingClientRect(),inside=rect&&gesture.x>=rect.left-12&&gesture.x<=rect.right+12&&gesture.y>=rect.top-12&&gesture.y<=rect.bottom+12;
    gesture.deleteTarget=gesture.payload.type==='stage'&&inside?zone:null;zone?.classList.toggle('drag-over',Boolean(gesture.deleteTarget));
    if(gesture.deleteTarget){activeSlot=null;stack.querySelectorAll('.drop-slot.active').forEach(node=>node.classList.remove('active'));}
    else updateSnap(stack,run,gesture.x,gesture.y);
  }
  function pointerDragFrame(){
    const gesture=pointerGesture;if(!gesture?.started)return;
    const scroll=gesture.source.closest('.conversation-scroll'),rect=scroll?.getBoundingClientRect();if(rect&&gesture.x>=rect.left&&gesture.x<=rect.right){const speed=gesture.y<rect.top+42?-Math.min(13,(rect.top+42-gesture.y)/3):gesture.y>rect.bottom-42?Math.min(13,(gesture.y-rect.bottom+42)/3):0;if(speed)scroll.scrollTop+=speed;}
    pointerDragTarget(gesture);gesture.frame=requestAnimationFrame(pointerDragFrame);
  }
  function movePointerDrag(event){
    const gesture=pointerGesture;if(!gesture||event.pointerId!==gesture.id)return;
    gesture.x=event.clientX;gesture.y=event.clientY;
    if(!gesture.started&&Math.hypot(gesture.x-gesture.originX,gesture.y-gesture.originY)<6)return;
    event.preventDefault();
    if(!gesture.started){gesture.started=true;dragPointerPending=null;dragState=gesture.payload;document.querySelectorAll('.workflow-stage').forEach(node=>node.getAnimations().forEach(animation=>animation.finish()));document.body.classList.add('drag-in-progress','pointer-drag-in-progress');gesture.source.classList.add('pointer-drag-source');if(gesture.payload.type==='stage')gesture.source.closest('.workflow-stage')?.classList.add('dragging');const run=runs().find(run=>run.id===gesture.runId),stage=run&&editableStages(run).find(stage=>stage.id===gesture.payload.stageId),provider=providerById(gesture.payload.providerId||stage?.provider);gesture.ghost=append(el('div','pointer-drag-ghost '+pclass(provider?.id)),el('span','provider-marker'),el('span','',stage?.name||pname(provider)));gesture.ghost.setAttribute('aria-hidden','true');document.body.append(gesture.ghost);document.querySelectorAll('.delete-zone').forEach(node=>node.classList.toggle('active',gesture.payload.type==='stage'&&node.dataset.runId===gesture.runId));gesture.frame=requestAnimationFrame(pointerDragFrame);}
    gesture.ghost.style.transform=`translate3d(${gesture.x+16}px,${gesture.y+14}px,0)`;pointerDragTarget(gesture);
  }
  function finishPointerDrag(event){
    const gesture=pointerGesture;if(!gesture||event.pointerId!==gesture.id)return;
    if(gesture.started){gesture.x=event.clientX;gesture.y=event.clientY;pointerDragTarget(gesture);}
    const run=runs().find(run=>run.id===gesture.runId),payload=gesture.payload,index=activeSlot?.runId===gesture.runId?activeSlot.index:null,remove=Boolean(gesture.deleteTarget),started=gesture.started;
    clearDrag();if(started)event.preventDefault();
    if(started&&run?.status==='awaiting_confirmation'){if(remove)removeStage(run,payload.stageId);else if(index!==null){if(payload.type==='provider')insertProvider(run,payload.providerId,index);else reorderStage(run,payload.stageId,index);}else render({force:true});}else render({force:true});
  }
  function handleDrop(event,run){if(!dragState||activeSlot?.runId!==run.id)return;event.preventDefault();const payload=dragState,index=activeSlot.index;clearDrag();if(payload.type==='provider')insertProvider(run,payload.providerId,index);else reorderStage(run,payload.stageId,index);}
  function insertProvider(run,id,index){const stages=editableStages(run),provider=providerById(id);if(!providerReady(provider)){toast('请先登录或验证连接',true);return;}if(stages.length>=16){toast('最多 16 个节点',true);return;}stages.splice(Math.max(1,Math.min(stages.length-1,index)),0,{id:'stage-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6),name:pname(provider),role:'execute',provider:id,model:'',effort:'default',enabled:true});render({force:true,flip:true});$('drag-status').textContent='已添加 '+pname(provider);}
  function reorderStage(run,id,index){const stages=editableStages(run),from=stages.findIndex(s=>s.id===id);if(from<=0||from>=stages.length-1)return;const [item]=stages.splice(from,1);if(from<index)index--;stages.splice(Math.max(1,Math.min(stages.length-1,index)),0,item);render({force:true,flip:true});$('drag-status').textContent='已移动节点';}
  function moveStage(run,id,direction){const stages=editableStages(run),from=stages.findIndex(s=>s.id===id),to=from+direction;if(from<=0||from>=stages.length-1||to<=0||to>=stages.length-1)return;[stages[from],stages[to]]=[stages[to],stages[from]];render({force:true,flip:true});}
  function removeStage(run,id){const stages=editableStages(run),at=stages.findIndex(s=>s.id===id);if(at<=0||at>=stages.length-1)return;if(stages[at].role==='execute'&&stages.filter(s=>s.role==='execute').length<=1){toast('至少保留一个执行节点',true);return;}stages.splice(at,1);render({force:true,flip:true});$('drag-status').textContent='已移除节点';}
  async function chooseRunWorkspace(run){await action(async()=>{const chosen=await call('chooseWorkspace');if(chosen){if(!proposalDrafts.has(run.id))editableStages(run);proposalDrafts.get(run.id).workspace=chosen;toast('目录已选择');}});}
  async function confirmWorkflow(run){await action(async()=>{const stages=editableStages(run);const args={runId:run.id,stages:clone(stages)};if(stages.workspace)args.workspace=stages.workspace;await call('confirmWorkflow',args);proposalDrafts.delete(run.id);await refresh();});}
  function renderRunControls(parent,run){const controls=el('div','run-controls');if(run.status==='running'){const p=button(run.pauseRequested?'将暂停':'暂停','quiet-button compact','pause',()=>control(run,'pause'));p.disabled=run.pauseRequested||busy;controls.append(p);}if(run.status==='paused')controls.append(button('继续','primary-button compact','play',()=>control(run,'resume')));if(['failed','review_failed','interrupted','cancelled'].includes(run.status))controls.append(button(run.status==='review_failed'?'修改并重试':'重试','quiet-button compact','retry',()=>control(run,'retry')));if(isLive(run)&&run.status!=='cancelling')controls.append(iconButton('取消任务','stop',async()=>{if(await confirmAction('取消任务？','已完成的输出会保留。','取消任务'))control(run,'cancel');}));if(run.workspace)controls.append(iconButton('打开工作目录','folder',()=>action(()=>call('openWorkspace',run.workspace))));controls.querySelectorAll('button').forEach(n=>n.disabled=n.disabled||busy);if(controls.children.length)parent.append(controls);}
  async function control(run,actionName){await action(async()=>{await call('controlRun',{action:actionName,runId:run.id});await refresh();});}
  function acceptancePanel(run){const panel=el('section','acceptance-panel');const input=el('textarea','acceptance-feedback');input.placeholder='修改意见（可选）';input.setAttribute('aria-label','最终验收反馈');input.dataset.focusId='feedback-'+run.id;input.value=feedbacks.get(run.id)||'';input.addEventListener('input',()=>feedbacks.set(run.id,input.value));const actions=append(el('div','workflow-actions'),button('确认交付','primary-button','check',()=>acceptResult(run,true)),button('需要修改','quiet-button','retry',()=>acceptResult(run,false)));actions.querySelectorAll('button').forEach(n=>n.disabled=busy);return append(panel,input,actions);}
  async function acceptResult(run,accepted){await action(async()=>{await call('confirmResult',{runId:run.id,accepted,feedback:feedbacks.get(run.id)||''});await refresh();});}
  async function loadHandoff(run,stage){const key=run.id+':'+stage.id;if(handoffs.get(key)?.loading)return;handoffs.set(key,{loading:true});try{const result=await call('prepareHandoff',{runId:run.id,stageId:stage.id});if(!result?.prompt)throw new Error('未收到交接提示');handoffs.set(key,{prompt:result.prompt});}catch(e){handoffs.set(key,{error:errorText(e)});showError(e);}render();}
  function handoffPanel(run,stage){const key=run.id+':'+stage.id,saved=handoffs.get(key),panel=el('section','handoff');panel.append(el('h4','','交接 · '+pname(providerById(stage.provider)||{id:stage.provider})));if(!saved)queueMicrotask(()=>loadHandoff(run,stage));if(saved?.prompt){panel.append(el('pre','output-text',saved.prompt));panel.append(button('复制并打开','outline-button compact','external',()=>action(async()=>{await writeClipboard(saved.prompt);await call('openProvider',stage.provider);toast('已复制，请在原应用执行');})));}else if(saved?.error)append(panel,el('p','stage-error',saved.error),button('重试','quiet-button compact','retry',()=>loadHandoff(run,stage)));const input=el('textarea');input.placeholder='粘贴实际结果…';input.setAttribute('aria-label','交接结果');input.dataset.focusId='handoff-'+key;input.value=handoffResults.get(key)||'';const submit=button('提交结果','primary-button compact','arrow',()=>action(async()=>{const text=handoffResults.get(key)?.trim();if(!text)throw new Error('请粘贴实际结果');await call('completeHandoff',{runId:run.id,stageId:stage.id,text});handoffResults.delete(key);await refresh();}));submit.disabled=busy||!input.value.trim();input.addEventListener('input',()=>{handoffResults.set(key,input.value);submit.disabled=busy||!input.value.trim();});return append(panel,input,submit);}
  async function writeClipboard(text){if(!text)throw new Error('没有可复制内容');if(typeof bridge?.copyText==='function'){await call('copyText',text);return;}if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return;}throw new Error('请选中文本后复制');}
  async function copyText(text,message){try{await writeClipboard(text);toast(message);}catch(e){showError(e);}}
  async function exportRun(run){await action(async()=>{if(await call('exportRun',run.id))toast('已导出');});}
  async function confirmAction(title,message,confirmLabel){const dialog=$('confirm-dialog');$('dialog-title').textContent=title;$('dialog-message').textContent=message;$('dialog-confirm').textContent=confirmLabel;$('dialog-symbol').replaceChildren(icon('info'));return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});dialog.returnValue='';showDialog(dialog);});}
  function heading(title,actionNode){return append(el('div','page-heading'),el('h1','',title),actionNode);}
  function renderConnections(main){
    const add=button('+ API','outline-button compact',null,()=>apiDialog());const refreshButton=iconButton('重新检测','retry',()=>action(async()=>{const next=await call('refreshProviders');if(next?.providers)acceptState(next);else await refresh();}));main.append(heading('连接',append(el('div','connection-actions'),add,refreshButton)));
    providers().forEach(provider=>{const item=el('article','connection-item '+pclass(provider.id));const avatar=el('div','provider-avatar',provider.id==='doubao'?'豆':pname(provider).slice(0,1));const title=append(el('div','provider-name'),avatar,append(el('div'),el('h2','',pname(provider)),el('div','connection-mode',provider.mode==='api'?'API':provider.mode==='cli'?'命令行':'桌面应用')));const actions=el('div','connection-actions');
      if(provider.mode==='api'){append(actions,iconButton('编辑 API','layers',()=>apiDialog(provider)),iconButton('刷新模型','retry',()=>action(async()=>{await call('refreshApiModels',provider.id);await refresh();toast('模型已更新');})),iconButton('移除 API','trash',async()=>{if(await confirmAction('移除此 API？',pname(provider),'移除'))action(async()=>{await call('removeApiProvider',provider.id);await refresh();});}));}
      else if(providerAuth(provider)?.kind!=='desktop'||provider.ready){const open=iconButton('打开应用','external',()=>action(()=>call('openProvider',provider.id)));open.disabled=!provider.installed||busy;actions.append(open);}
      const auth=providerAuth(provider);if(auth&&(!provider.ready||auth.pending))appendAuthActions(actions,provider,'outline-button compact');
      const test=providerTests.get(provider.id);if(['cli','api'].includes(provider.mode)&&provider.id!=='codex'){const verify=button(test?.pending?'验证中…':'验证连接','quiet-button compact','plug',()=>testConnection(provider));verify.title='真实验证会消耗少量用量';verify.disabled=busy||test?.pending;actions.append(verify);}
      append(item,append(el('div','connection-heading'),title,actions),el('p','connection-message',provider.auth?.state==='pending'?'授权中':provider.ready?'已就绪':provider.mode==='handoff'?'待接入':'未就绪'));
      if(test){const resultLine=append(el('div','connection-test '+(test.pending?'pending':test.ok?'passed':'failed')),icon(test.pending?'clock':test.ok?'checkCircle':'info'),el('span','',test.pending?'请求中…':test.ok?'真实调用成功':test.error));if(test.ok&&test.modelId)resultLine.append(el('small','connection-test-model',test.modelId+' · '+(effortNames[test.effort]||test.effort||'默认强度')));item.append(resultLine);}
      const details=el('details','connection-details');details.append(el('summary','','详情'));append(details,el('p','',provider.readinessReason?.message||provider.message||'—'),el('p','',String(provider.models?.length||0)+' 个模型'+(provider.mode==='api'?(provider.hasKey?' · 密钥已保存':' · 未配置密钥'):'')));
      if(test?.details)details.append(append(el('div','connection-technical'),el('pre','output-text',test.details)));if(auth&&!provider.ready&&!auth.opensApp)details.append(el('p','',auth.kind==='browser-cli'?'使用官方网页授权，无需复制密钥。':'在原应用完成登录后重新检测；可用状态以实际连接为准。'));item.append(details);main.append(item);
    });
  }
  async function testConnection(provider){if(busy)return;providerTests.set(provider.id,{pending:true});await action(async()=>{try{const result=await call('testProvider',provider.id);if(result?.ok!==true)throw new Error(result?.message||'未确认调用成功');providerTests.set(provider.id,{ok:true,usage:result.usage,modelId:result.modelId,effort:result.effort});await refresh();}catch(e){providerTests.set(provider.id,{ok:false,error:errorText(e),details:rawError(e)});throw e;}});}
  function apiDialog(provider){
    const dialog=el('dialog','confirm-dialog api-dialog'),form=el('form');form.method='dialog';form.append(el('h2','',provider?'编辑 API':'添加 API'));
    const field=(label,input)=>{const wrap=el('label','api-field');append(wrap,el('span','',label),input);form.append(wrap);return input;};
    const name=field('名称',el('input','text-input'));name.value=provider?.name||'';name.required=true;name.maxLength=80;
    const protocol=el('select','text-input');[['openai','OpenAI Chat'],['responses','OpenAI Responses'],['anthropic','Anthropic']].forEach(([value,label])=>{const o=el('option','',label);o.value=value;o.selected=value===(provider?.protocol||'openai');protocol.append(o);});field('协议',protocol);
    const url=field('地址',el('input','text-input'));url.type='url';url.required=true;url.placeholder='https://…/v1';url.value=provider?.baseUrl||'';
    const key=field(provider?.hasKey?'密钥（留空保留）':'密钥',el('input','text-input'));key.type='password';key.autocomplete='new-password';key.value='';
    const models=field('模型 ID（逗号分隔，可选）',el('input','text-input'));models.value=(provider?.models||[]).map(m=>typeof m==='string'?m:m.id).join(', ');
    const advanced=el('details','api-advanced');advanced.append(el('summary','','高级'));const levels=el('select','text-input');levels.multiple=true;levels.size=4;levels.setAttribute('aria-label','新模型思考强度');levels.title='仅选择接口明确支持的强度；默认不声明。已有模型保留原设置。';
    const buildLevels=()=>{const selected=new Set(Array.from(levels.selectedOptions).map(o=>o.value));levels.replaceChildren();const supported=protocol.value==='anthropic'?['default','low','medium','high','xhigh','max']:['default','none','minimal','low','medium','high','xhigh','max','ultra'];supported.forEach(value=>{const o=el('option','',effortNames[value]||value);o.value=value;o.selected=selected.size?selected.has(value):value==='default';levels.append(o);});};buildLevels();protocol.addEventListener('change',buildLevels);append(advanced,append(el('label','api-field'),el('span','','新模型思考强度'),levels));form.append(advanced);
    const actions=el('div','dialog-actions'),cancel=button('取消','quiet-button',null,()=>dialog.close()),save=button('保存','primary-button',null,async()=>{if(!form.reportValidity())return;save.disabled=true;const values={name:name.value.trim(),protocol:protocol.value,baseUrl:url.value.trim(),apiKey:key.value,models:models.value.split(',').map(s=>s.trim()).filter(Boolean).map(id=>{const known=provider?.models?.find(m=>(typeof m==='string'?m:m.id)===id);return known&&typeof known==='object'?clone(known):{id,efforts:Array.from(levels.selectedOptions).map(o=>o.value).filter(value=>value!=='default')};})};if(provider?.id)values.id=provider.id;try{await call('saveApiProvider',values);key.value='';dialog.close();await refresh();toast('API 已保存');}catch(e){showError(e);}finally{values.apiKey='';key.value='';save.disabled=false;}});append(actions,cancel,save);form.append(actions);form.addEventListener('submit',event=>{event.preventDefault();save.click();});dialog.append(form);document.body.append(dialog);dialog.addEventListener('close',()=>{key.value='';dialog.remove();},{once:true});showDialog(dialog);
  }
  function recentCalls(scope){return (Array.isArray(state.telemetry?.recentCalls)?state.telemetry.recentCalls:[]).filter(call=>call?.scope===scope&&typeof call.time==='string'&&Number.isFinite(Date.parse(call.time))).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));}
  function modelGroups(calls){const groups=new Map();calls.forEach(call=>{const key=charts.modelKey(call);if(!groups.has(key))groups.set(key,{key,label:charts.modelLabel(call),providerId:call.providerId,calls:[]});groups.get(key).calls.push(call);});return [...groups.values()].sort((a,b)=>Date.parse(b.calls.at(-1).time)-Date.parse(a.calls.at(-1).time));}
  function smallMetrics(usage={}){const row=el('dl','compact-metrics');[['输入',usage.input],['输出',usage.output]].forEach(([label,value])=>row.append(append(el('div'),el('dt','',label),el('dd',numeric(value)?'':'unknown',metric(value)))));row.title='缓存读 '+metric(usage.cacheRead)+' · 缓存写 '+metric(usage.cacheWrite)+' · 推理 '+metric(usage.reasoning)+' · 费用 '+money(usage.costUSD);return row;}
  function renderInspector(){
    const root=$('inspector');root.replaceChildren();const run=currentRun(),activity=append(el('section'),append(el('div','inspector-label'),el('h2','','活动'))),events=run?.events||[],list=el('ol','activity-list');
    events.slice(-4).reverse().forEach(event=>{const item=el('li','activity-item');item.dataset.type=event.type||'';append(item,el('span','activity-point'),append(el('div'),el('p','',event.message||event.type||'—'),el('div','activity-time',time(event.time))));list.append(item);});activity.append(events.length?list:el('p','source-note','—'));root.append(activity);
    const stage=run?.status==='planning'?run.starter:activeStage(run)||[...(run?.stages||[])].reverse().find(stage=>['completed','failed'].includes(stage.status)),usage=stage?.usage;
    const task=append(el('section','telemetry-section'),append(el('div','inspector-label'),el('h2','','本轮')),el('div','used-model',stage?stageModel(stage):'—'),smallMetrics(usage||{}));if(stage)task.append(conversationButton(run,stage,'当前环节对话'));if(partial(usage))task.append(el('span','partial-note','部分合计'));root.append(task);
    const taskOnly=state.telemetry?.tokenlens?.softwareSamplesSupported===false;
    const software=append(el('section','telemetry-section'),append(el('div','inspector-label'),el('h2','tokenlens-word',taskOnly?'任务用量':'近期用量'),iconButton('查看用量','chart',()=>navigate('usage'))));software.title=taskOnly?'AgentFlow 已保存任务的实际调用':'软件日志的近期限量样本；与任务调用分开显示。';
    const groups=modelGroups(recentCalls(taskOnly?'task':'software')).slice(0,3);
    if(groups.length)groups.forEach(group=>{const item=append(el('div','software-spark '+pclass(group.providerId)),el('div','used-model',group.label));item.append(charts.chart({calls:group.calls,metric:'input',compact:true,animate:false,cacheKey:'mini-'+group.key}));software.append(item);});
    else{const logged=(state.telemetry?.tokenlens?.providers||[]).flatMap(provider=>loggedModels(provider).map(model=>model.label||model.id)).slice(0,3);logged.forEach(label=>software.append(el('div','used-model',label)));software.append(el('p','source-note',logged.length?'暂无近期调用':'模型未记录'));}
    root.append(software);
  }
  function renderUsage(main){
    main.append(heading('用量',iconButton('刷新用量','retry',()=>action(async()=>{await call('refreshTelemetry');usageView.replay++;await refresh();}))));const surface=el('section','usage-explorer'),toolbar=el('div','usage-toolbar'),scope=el('div','segmented-control');scope.setAttribute('aria-label','用量来源');
    [['software','软件样本'],['task','任务调用']].forEach(([value,label])=>{const choice=button(label,'segment-button',null,()=>{usageView.scope=value;usageView.model='';usageView.replay++;render({force:true});});choice.setAttribute('aria-pressed',String(usageView.scope===value));if(value==='software'&&state.telemetry?.tokenlens?.softwareSamplesSupported===false){choice.disabled=true;choice.title='当前系统仅支持任务调用用量';}scope.append(choice);});
    const groups=modelGroups(recentCalls(usageView.scope)),select=el('select','usage-model-select');select.setAttribute('aria-label','用量模型');select.dataset.focusId='usage-model';
    if(!groups.some(group=>group.key===usageView.model))usageView.model=groups[0]?.key||'';
    if(!groups.length){const option=el('option','','暂无模型调用');option.value='';select.append(option);select.disabled=true;}else groups.forEach(group=>{const option=el('option','',group.label+' · '+pname(providerById(group.providerId)||{id:group.providerId}));option.value=group.key;option.selected=group.key===usageView.model;select.append(option);});
    select.addEventListener('change',()=>{usageView.model=select.value;usageView.replay++;render({force:true});});append(toolbar,scope,select);
    const type=el('div','segmented-control');type.setAttribute('aria-label','图表类型');[['line','折线'],['bar','条形']].forEach(([value,label])=>{const choice=button(label,'segment-button',null,()=>{usageView.type=value;usageView.replay++;render({force:true});});choice.setAttribute('aria-pressed',String(usageView.type===value));type.append(choice);});toolbar.append(type);surface.append(toolbar);
    const metrics=el('div','usage-metric-tabs');metrics.setAttribute('aria-label','用量指标');Object.entries(charts.fields).forEach(([value,label])=>{const choice=button(label,'usage-metric-tab metric-'+value,null,()=>{usageView.metric=value;usageView.replay++;render({force:true});});choice.setAttribute('aria-pressed',String(usageView.metric===value));if(value==='cacheRead')choice.title='缓存读取包含于输入，不重复相加';metrics.append(choice);});surface.append(metrics);
    const group=groups.find(group=>group.key===usageView.model),calls=group?.calls||[],layout=el('div','usage-analytics-layout');
    layout.append(charts.chart({calls,metric:usageView.metric,type:usageView.type,animate:true,cacheKey:'usage-main',replayKey:usageView.replay,onCall:call=>{const run=runs().find(run=>run.id===call.runId),stage=call.stageId==='starter'?run?.starter:run?.stages?.find(stage=>stage.id===call.stageId);if(run&&stage)openConversation(run,stage,call.attemptId);}}));
    const distribution=el('section','usage-distribution'),distributionMetric=el('select','usage-distribution-select');distributionMetric.setAttribute('aria-label','样本占比指标');distributionMetric.dataset.focusId='usage-distribution-metric';[['tokens','输入 + 输出'],...Object.entries(charts.fields)].forEach(([value,label])=>{const option=el('option','',value==='costUSD'?'费用（USD）':label);option.value=value;option.selected=usageView.distributionMetric===value;distributionMetric.append(option);});distributionMetric.addEventListener('change',()=>{usageView.distributionMetric=distributionMetric.value;usageView.replay++;render({force:true});});
    distribution.append(append(el('div','usage-distribution-head'),el('h2','',usageView.scope==='task'?'任务样本占比':'近期样本占比'),distributionMetric),charts.distribution({calls:recentCalls(usageView.scope),metric:usageView.distributionMetric,selectedModel:usageView.model,replayKey:usageView.replay,providerName:id=>pname(providerById(id)||{id}),onSelect:key=>{usageView.model=key;usageView.replay++;render({force:true});}}));layout.append(distribution);surface.append(layout);
    const note=el('p','usage-sample-note',usageView.scope==='software'?'最近 7 天 · 限量软件样本':'任务样本');note.title=(usageView.scope==='software'?'每个软件最多 96 条、合计最多 480 条近期样本。':'最多 480 次已保存尝试。')+' 曲线每模型显示最近 80 次；未知指标不当作零，软件与任务独立显示。';surface.append(note);main.append(surface);
  }

  function conversationButton(run,stage,label){const control=button('对话','quiet-button compact','history',()=>openConversation(run,stage));control.setAttribute('aria-label',label);control.title=label;control.disabled=!stage||(!stage.text&&!stage.attempts?.length&&['pending','skipped'].includes(stage.status));return control;}
  async function copyConversationField(run,stage,attempt,field,text,messageId){try{if(typeof bridge?.copyConversation==='function'&&(field!=='message'||messageId))await call('copyConversation',{runId:run.id,stageId:stage.id||'starter',attemptId:attempt.id,field,...(messageId?{messageId}:{})});else await writeClipboard(text);toast('已复制');}catch(error){showError(error);}}
  async function openConversation(run,stage,attemptId){
    const dialog=el('dialog','confirm-dialog conversation-dialog');dialog.setAttribute('aria-label',(stage.name||roles[stage.role]||'启动模型')+'对话');let currentAttemptId=attemptId,request=0;
    const head=append(el('div','conversation-dialog-head'),el('h2','',stage===run.starter?'启动模型对话':(stage.name||roles[stage.role]||'环节')+'对话'),append(el('div','conversation-dialog-actions'),iconButton('刷新对话','retry',()=>load(currentAttemptId)),iconButton('关闭对话','close',()=>dialog.close()))),body=el('div','conversation-dialog-body');append(dialog,head,body);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});showDialog(dialog);
    const load=async selected=>{const revision=++request,scrollTop=body.scrollTop;body.replaceChildren(el('div','conversation-loading','正在读取对话…'));try{const value=await call('getConversation',{runId:run.id,stageId:stage.id||'starter',...(selected?{attemptId:selected}:{})});if(!dialog.isConnected||revision!==request)return;const attempts=(Array.isArray(value?.attempts)?value.attempts:[]).map(attempt=>({...attempt,id:attempt.id||attempt.attemptId})),current=attempts.find(attempt=>attempt.id===(value.selectedAttemptId||selected))||attempts.at(-1);body.replaceChildren();if(!current){body.append(el('p','conversation-empty','暂无对话记录'));return;}currentAttemptId=current.id;
      const toolbar=el('div','conversation-attempt-toolbar'),picker=el('select','text-input');picker.setAttribute('aria-label','对话尝试');attempts.forEach((attempt,index)=>{const option=el('option','',`尝试 ${index+1} · ${time(attempt.startedAt,true)} · ${labels[attempt.status]||attempt.status||'—'}`);option.value=attempt.id;option.selected=attempt.id===current.id;picker.append(option);});picker.addEventListener('change',()=>load(picker.value));toolbar.append(picker,statusBadge(current.status));body.append(toolbar);
      const meta=el('div','conversation-meta');[pname(providerById(current.providerId)||{id:current.providerId}),current.actualModelId||current.modelId||'默认未回报',effortNames[current.effort]||current.effort||'默认强度',charts.date(current.startedAt,true)].forEach(value=>meta.append(el('span','',value)));body.append(meta);
      if(current.legacy||current.truncated)body.append(el('p','conversation-record-note',[current.legacy?'历史记录':'',current.truncated?'记录已截断':''].filter(Boolean).join(' · ')));
      const copy=(field,text,messageId)=>copyConversationField(run,stage,current,field,text,messageId);
      const block=(title,text,missing,field='output')=>{const section=el('section','conversation-message'),top=append(el('div','conversation-message-head'),el('h3','',title));if(typeof text==='string'&&text)top.append(iconButton('复制'+title,'copy',()=>copy(field,text)));section.append(top,typeof text==='string'&&text?el('pre','output-text',text):el('p','conversation-empty',missing));return section;};
      body.append(block('实际发送',current.inputCaptured===true?current.input:null,'此尝试未记录发送内容','input'));
      const messages=(Array.isArray(current.messages)?current.messages:[]).filter(message=>message?.role==='assistant'&&typeof message.text==='string'),output=typeof current.output==='string'?current.output:'';
      if(current.messageCapture==='final-only')body.append(block('最终公开回复',messages.at(-1)?.text||output,'尚未收到公开回复'));
      else if(messages.length){const replies=append(el('section','conversation-message'),append(el('div','conversation-message-head'),el('h3','','公开回复'),iconButton('复制最终回复','copy',()=>copy('output',output))));messages.forEach((message,index)=>{const details=el('details','conversation-public-message');details.open=index===messages.length-1;details.append(append(el('summary'),el('span','','回复 '+(index+1)),el('time','',charts.date(message.time,true))),append(el('div','conversation-public-message-actions'),iconButton('复制这条回复','copy',()=>copy('message',message.text,message.id))),el('pre','output-text',message.text));replies.append(details);});body.append(replies);const text=output.trim(),same=text===messages.at(-1).text.trim()||['','\n','\n\n'].some(separator=>text===messages.map(message=>message.text).join(separator).trim());if(text&&!same)body.append(block('最终回复',output,''));}
      else body.append(block('公开回复',output,'尚未收到公开回复'));
      const details=el('details','conversation-record-details');details.append(el('summary','','记录详情'));[['开始',current.startedAt],['结束',current.finishedAt]].forEach(([label,value])=>details.append(el('p','',label+' · '+charts.date(value,true))));if(current.origin)details.append(el('p','','来源 · '+current.origin));if(current.sessionId)details.append(el('p','','会话 · '+current.sessionId));const activities=Array.isArray(current.activities)?current.activities:[];activities.forEach(activity=>details.append(el('p','',charts.date(activity.time,true)+' · '+(activity.message||activity.type||'—'))));body.append(details);body.scrollTop=scrollTop;
    }catch(error){if(dialog.isConnected&&revision===request)body.replaceChildren(errorBlock(error),button('重试','quiet-button compact','retry',()=>load(selected)));}};
    await load(attemptId);
  }
  $('sidebar-toggle').append(icon('menu'));$('sidebar-toggle').addEventListener('click',()=>$('app').classList.toggle('sidebar-expanded'));
  append($('new-task'),icon('plus'),el('span','nav-label','新任务'));$('new-task').addEventListener('click',newTask);document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();newTask();});
  document.addEventListener('pointerdown',beginPointerDrag,{capture:true});document.addEventListener('pointermove',movePointerDrag,{capture:true,passive:false});document.addEventListener('pointerup',finishPointerDrag,{capture:true});document.addEventListener('pointercancel',releaseDragPointer,{capture:true});
  document.addEventListener('dragstart',event=>{if(pointerGesture){event.preventDefault();event.stopPropagation();}},{capture:true});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&pointerGesture){event.preventDefault();releaseDragPointer();}},{capture:true});
  document.addEventListener('focusout',event=>{if(event.target?.tagName!=='SELECT')return;clearTimeout(selectBlurTimer);selectBlurTimer=setTimeout(()=>{const active=document.activeElement;if(!document.hasFocus()||active?.tagName==='SELECT'||active===document.body)return;render();},120);});document.addEventListener('focusin',event=>{if(event.target?.tagName==='SELECT')clearTimeout(selectBlurTimer);});document.addEventListener('dragend',()=>{const wasDragging=Boolean(dragState);clearDrag();if(wasDragging)render({force:true});});document.addEventListener('compositionstart',()=>{compositionActive=true;});document.addEventListener('compositionend',event=>{compositionActive=false;if(event.target?.id==='composer-prompt')composerCompositionEndedAt=performance.now();setTimeout(()=>render({force:true}),0);});document.addEventListener('keyup',event=>{if(event.key==='Enter'||event.keyCode===13)composerEnterHeld=false;});window.addEventListener('blur',()=>{composerEnterHeld=false;clearTimeout(selectBlurTimer);releaseDragPointer();});
  if(bridge){if(typeof bridge.onState==='function')bridge.onState(next=>{try{acceptState(next);}catch(e){showError(e);}});refresh().catch(e=>showError(e));}render();
})();

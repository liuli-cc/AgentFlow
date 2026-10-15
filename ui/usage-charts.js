'use strict';
(() => {
  const NS='http://www.w3.org/2000/svg',cache=new Map();let serial=0;
  const fields={input:'输入',output:'输出',cacheRead:'缓存读',cacheWrite:'缓存写',reasoning:'推理',costUSD:'费用'};
  const valid=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  const number=value=>valid(value)?new Intl.NumberFormat('zh-CN').format(value):'未提供';
  const currency=value=>valid(value)?value>0&&value<.000001?'$'+value.toExponential(2):'$'+new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(value):'未提供';
  const display=(value,metric)=>metric==='costUSD'?currency(value):number(value);
  const stamp=value=>typeof value==='string'?Date.parse(value):NaN;
  const modelKey=call=>String(call.providerId||'unknown')+'\u001f'+String(call.modelId||'unknown');
  const modelLabel=call=>call.modelLabel||call.modelId||'模型未记录';
  const node=(tag,cls,text)=>{const value=document.createElement(tag);if(cls)value.className=cls;if(text!==undefined)value.textContent=String(text);return value;};
  const svg=(tag,attributes={})=>{const value=document.createElementNS(NS,tag);for(const [key,item]of Object.entries(attributes))value.setAttribute(key,String(item));return value;};
  const date=(value,full=false)=>{const time=stamp(value);return Number.isFinite(time)?new Intl.DateTimeFormat('zh-CN',full?{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}:{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(time)):'时间未记录';};
  const sorted=calls=>calls.filter(call=>call&&Number.isFinite(stamp(call.time))).sort((a,b)=>stamp(a.time)-stamp(b.time));
  const fingerprint=calls=>calls.map(call=>[call.id,call.providerId,call.modelId,call.modelLabel,call.time,call.scope,call.source,call.runId,call.stageId,call.attemptId,...Object.keys(fields).map(key=>valid(call.usage?.[key])?call.usage[key]:null)]);
  function memo(key,signature,create){if(key&&cache.get(key)?.signature===signature)return cache.get(key).node;const value=create();if(key){cache.set(key,{signature,node:value});if(cache.size>6)cache.delete(cache.keys().next().value);}return value;}
  function play(target,frames,options){const animation=target.animate(frames,options);animation.addEventListener('finish',()=>animation.cancel(),{once:true});return animation;}
  const motion=()=>!matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ceiling=value=>{if(!value)return 1;const unit=10**Math.floor(Math.log10(value)),ratio=value/unit;return([1,2,2.5,4,5,10].find(step=>step>=ratio)||10)*unit;};
  function curvePath(points){
    const widths=points.slice(1).map((point,index)=>point[0]-points[index][0]),deltas=widths.map((width,index)=>width>0?(points[index+1][1]-points[index][1])/width:null);
    const slopes=points.map((_,index)=>{if(index===0)return deltas[0]??0;if(index===points.length-1)return deltas[index-1]??0;const before=deltas[index-1],after=deltas[index];if(before===null||after===null||before*after<=0)return 0;const w1=2*widths[index]+widths[index-1],w2=widths[index]+2*widths[index-1];return(w1+w2)/(w1/before+w2/after);});
    let path=`M ${points[0].join(' ')}`;for(let index=0;index<points.length-1;index++){const a=points[index],b=points[index+1],width=widths[index],delta=deltas[index];if(!(width>0)){path+=` L ${b.join(' ')}`;continue;}let m1=slopes[index],m2=slopes[index+1];if(delta===0)m1=m2=0;else{const alpha=Math.max(0,m1/delta),beta=Math.max(0,m2/delta),length=Math.hypot(alpha,beta),factor=length>3?3/length:1;m1=alpha*factor*delta;m2=beta*factor*delta;}
      path+=` C ${a[0]+width/3} ${a[1]+m1*width/3} ${b[0]-width/3} ${b[1]-m2*width/3} ${b.join(' ')}`;
    }return path;
  }
  function row(parent,label,value){const line=node('div','usage-tooltip-row');line.append(node('span','',label),node('b','',value));parent.append(line);}
  function chart({calls=[],metric='input',type='line',compact=false,animate=true,onCall,cacheKey,replayKey=0}={}){
    const all=sorted(calls),points=all.slice(compact?-24:-80);
    const signature=JSON.stringify([metric,type,compact,replayKey,motion(),fingerprint(points)]);
    return memo(cacheKey,signature,()=>{
      const figure=node('figure','usage-plot metric-'+metric+(compact?' compact':'')),known=points.filter(call=>valid(call.usage?.[metric]));figure.dataset.replay=String(replayKey);
      if(!points.length||!known.length){const empty=node('div','chart-empty');empty.append(node('span','chart-empty-mark','—'),node('p','',points.length?'此指标未提供':'暂无近期调用'));figure.append(empty);return figure;}
      const width=compact?260:1000,height=compact?72:310,margin=compact?{left:4,right:4,top:8,bottom:7}:{left:76,right:28,top:30,bottom:52};
      const innerWidth=width-margin.left-margin.right,innerHeight=height-margin.top-margin.bottom,base=margin.top+innerHeight;
      const start=stamp(points[0].time),end=stamp(points.at(-1).time),maximum=ceiling(Math.max(...known.map(call=>call.usage[metric])));
      const x=(call,index)=>type==='bar'?margin.left+innerWidth*(index+.5)/points.length:end===start?margin.left+innerWidth/2:margin.left+(stamp(call.time)-start)/(end-start)*innerWidth;
      const y=value=>margin.top+innerHeight*(1-value/maximum);
      const drawing=svg('svg',{viewBox:`0 0 ${width} ${height}`,role:compact?'img':'group','aria-label':`${modelLabel(points[0])} ${fields[metric]}，${points.length} 次真实调用，${type==='bar'?'条形图':'折线图'}`});
      drawing.append(svg('title'));drawing.firstChild.textContent=drawing.getAttribute('aria-label');
      if(!compact){
        for(const ratio of [0,.25,.5,.75,1]){const at=margin.top+innerHeight*(1-ratio),line=svg('line',{x1:margin.left,y1:at,x2:width-margin.right,y2:at,class:'usage-grid'}),label=svg('text',{x:margin.left-18,y:at+4,'text-anchor':'end',class:'usage-axis'});label.textContent=metric==='costUSD'?currency(maximum*ratio):new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(maximum*ratio);drawing.append(line,label);}
        const crossDay=new Date(start).toDateString()!==new Date(end).toDateString();
        // Time-axis ticks are evenly spaced in the domain. A median call can
        // sit almost on top of the first call during a burst of requests.
        const ticks=type==='bar'?[...new Set([0,Math.floor((points.length-1)/2),points.length-1])].map((index,i,list)=>({time:points[index].time,x:x(points[index],index),anchor:list.length===1?'middle':i===0?'start':i===list.length-1?'end':'middle'})):
          start===end?[{time:points[0].time,x:margin.left+innerWidth/2,anchor:'middle'}]:[0,.5,1].map(ratio=>({time:new Date(start+(end-start)*ratio).toISOString(),x:margin.left+innerWidth*ratio,anchor:ratio===0?'start':ratio===1?'end':'middle'}));
        for(const tick of ticks){const label=svg('text',{x:tick.x,y:height-17,'text-anchor':tick.anchor,class:'usage-axis'});label.textContent=crossDay?new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(stamp(tick.time))):date(tick.time);drawing.append(label);}
      }
      const defs=svg('defs'),clip=svg('clipPath',{id:'usage-reveal-'+(++serial)}),mask=svg('rect',{x:margin.left-5,y:0,width:innerWidth+10,height,class:'usage-reveal-mask'}),gradient=svg('linearGradient',{id:'usage-fill-'+serial,x1:0,y1:0,x2:0,y2:1});for(const [offset,opacity]of [[0,.13],[1,.01]]){const stop=svg('stop',{offset,'stop-opacity':opacity});stop.style.stopColor='var(--chart-color, #c291ff)';gradient.append(stop);}clip.append(mask);defs.append(clip,gradient);drawing.append(defs);
      const marks=svg('g',{'clip-path':`url(#${clip.id})`,class:'usage-marks'});drawing.append(marks);
      if(type==='line'){
        let segment=[];const flush=()=>{if(segment.length>1){const path=curvePath(segment),area=svg('path',{d:`${path} L ${segment.at(-1)[0]} ${base} L ${segment[0][0]} ${base} Z`,class:'usage-area'});area.style.fill=`url(#${gradient.id})`;marks.append(area,svg('path',{d:path,class:'usage-trace'}));}segment=[];};
        points.forEach((call,index)=>{const value=call.usage?.[metric];if(valid(value))segment.push([x(call,index),y(value)]);else flush();});flush();
        points.forEach((call,index)=>{const value=call.usage?.[metric];if(valid(value))marks.append(svg('circle',{cx:x(call,index),cy:y(value),r:compact?1.5:points.length>28?2.3:3.3,class:'usage-dot'}));});
        if(animate&&motion()){figure.dataset.animation='line-reveal';play(mask,[{width:'0px'},{width:(innerWidth+10)+'px'}],{duration:compact?520:950,easing:'cubic-bezier(.2,.65,.3,1)',fill:'both'});}
      }else{
        const barWidth=Math.max(2,Math.min(42,innerWidth/points.length*.66));let order=0;
        points.forEach((call,index)=>{const value=call.usage?.[metric];if(!valid(value))return;const bar=svg('rect',{x:x(call,index)-barWidth/2,y:y(value),width:barWidth,height:Math.max(0,base-y(value)),rx:Math.min(3,barWidth/4),class:'usage-bar'});marks.append(bar);if(animate&&motion()){figure.dataset.animation='bar-rise';play(bar,[{transform:'scaleY(0)'},{transform:'scaleY(1)'}],{duration:620,delay:Math.min(order++*16,300),easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});}});
      }
      const tooltip=node('div','usage-tooltip');tooltip.setAttribute('role','tooltip');tooltip.hidden=true;
      const show=(call,event)=>{tooltip.replaceChildren(node('strong','',modelLabel(call)),node('span','usage-tooltip-time',date(call.time,true)));for(const [key,label]of Object.entries(fields))row(tooltip,label,display(call.usage?.[key],key));tooltip.append(node('span','usage-tooltip-source',(call.scope==='task'?'任务调用':'软件样本')+(call.source?' · '+call.source:'')));tooltip.hidden=false;const rect=figure.getBoundingClientRect();tooltip.style.left=Math.max(0,Math.min(rect.width-222,(event?.clientX||rect.left+rect.width/2)-rect.left+12))+'px';tooltip.style.top=compact?'76px':'34px';};
      points.forEach((call,index)=>{const hit=svg('rect',{x:x(call,index)-(compact?6:Math.max(6,innerWidth/points.length/2)),y:margin.top,width:compact?12:Math.max(12,innerWidth/points.length),height:innerHeight,class:'usage-hit',tabindex:compact?'-1':'0',role:onCall&&call.runId&&call.stageId?'button':'img','aria-label':`${modelLabel(call)}，${date(call.time,true)}，${fields[metric]} ${display(call.usage?.[metric],metric)}`});hit.addEventListener('pointerenter',event=>show(call,event));hit.addEventListener('pointerleave',()=>tooltip.hidden=true);hit.addEventListener('focus',()=>show(call));hit.addEventListener('blur',()=>tooltip.hidden=true);if(onCall&&call.runId&&call.stageId){hit.addEventListener('click',()=>onCall(call));hit.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onCall(call);}});}drawing.append(hit);});
      figure.append(drawing,tooltip);if(!compact){const foot=node('figcaption','usage-chart-caption');foot.append(node('span','',`${points.length} 次调用${all.length>points.length?' · 最近 80 次':''}`),node('span','',type==='bar'?'逐次调用':`${date(points[0].time,true)} — ${date(points.at(-1).time,true)}`));figure.append(foot);}return figure;
    });
  }
  const palette=['#b993ed','#78b6da','#72c7b0','#d6ad7a','#c98da9','#8e9fe4','#bccb86','#ce91d1'],modelColors=new Map();
  function color(key){if(modelColors.has(key))return modelColors.get(key);let hash=0;for(const char of key)hash=(hash*31+char.charCodeAt(0))>>>0;const used=new Set(modelColors.values());let value;for(let offset=0;offset<palette.length;offset++){const candidate=palette[(hash+offset)%palette.length];if(!used.has(candidate)){value=candidate;break;}}if(!value)value=`hsl(${(hash+modelColors.size*137.508)%360} 48% 68%)`;modelColors.set(key,value);return value;}
  function distributionGroups(calls,metric){
    const groups=new Map();for(const call of sorted(calls)){const key=modelKey(call);if(!groups.has(key))groups.set(key,{key,label:modelLabel(call),providerId:call.providerId,calls:[],value:null,known:0});const group=groups.get(key);group.calls.push(call);const value=metric==='tokens'?(valid(call.usage?.input)&&valid(call.usage?.output)?call.usage.input+call.usage.output:null):call.usage?.[metric];if(valid(value)){group.value=(group.value??0)+value;group.known++;}}
    return [...groups.values()].sort((a,b)=>(b.value??-1)-(a.value??-1)||a.key.localeCompare(b.key));
  }
  function ringPath(start,end){const point=(angle,r)=>[140+Math.cos(angle)*r,140+Math.sin(angle)*r],span=end-start;if(span>=Math.PI*2-.00001)return'M 140 29 A 111 111 0 1 1 140 251 A 111 111 0 1 1 140 29 M 140 62 A 78 78 0 1 0 140 218 A 78 78 0 1 0 140 62 Z';const gap=Math.min(.014,span*.08);start+=gap;end-=gap;const a=point(start,111),b=point(end,111),c=point(end,78),d=point(start,78),large=end-start>Math.PI?1:0;return`M ${a.join(' ')} A 111 111 0 ${large} 1 ${b.join(' ')} L ${c.join(' ')} A 78 78 0 ${large} 0 ${d.join(' ')} Z`;}
  function distribution({calls=[],metric='tokens',selectedModel='',providerName=id=>id||'—',onSelect,cacheKey='usage-distribution',replayKey=0,animate=true}={}){
    const all=sorted(calls),signature=JSON.stringify([metric,selectedModel,replayKey,motion(),fingerprint(all)]);
    return memo(cacheKey,signature,()=>{
      const body=node('div','usage-distribution-body'),wrap=node('div','usage-donut-wrap'),drawing=svg('svg',{viewBox:'0 0 280 280',class:'usage-donut',role:'group','aria-label':'近期样本占比'}),legend=node('ul','usage-model-legend'),tooltip=node('div','usage-tooltip');tooltip.setAttribute('role','tooltip');tooltip.hidden=true;
      const groups=distributionGroups(all,metric),total=groups.reduce((sum,group)=>sum+(valid(group.value)?group.value:0),0),knownCount=groups.reduce((sum,group)=>sum+group.known,0),slices=new Map();body.dataset.total=String(total);body.dataset.known=String(knownCount);body.dataset.calls=String(all.length);
      const hide=()=>{tooltip.hidden=true;slices.forEach(slice=>slice.classList.remove('is-highlighted'));};
      const show=(group,event)=>{slices.forEach((slice,key)=>slice.classList.toggle('is-highlighted',key===group.key));tooltip.replaceChildren(node('strong','',group.label),node('span','usage-tooltip-time',providerName(group.providerId)+' · '+group.calls.length+' 次调用'));for(const key of ['input','output','cacheRead','cacheWrite']){const values=group.calls.map(call=>call.usage?.[key]).filter(valid);row(tooltip,fields[key],values.length?number(values.reduce((a,b)=>a+b,0))+(values.length<group.calls.length?'（部分）':''):'未提供');}row(tooltip,metric==='tokens'?'输入 + 输出':fields[metric],display(group.value,metric));row(tooltip,'样本份额',total>0&&valid(group.value)?(group.value/total*100).toFixed(1)+'%':'未提供');tooltip.append(node('span','usage-tooltip-source',`${date(group.calls[0].time,true)} — ${date(group.calls.at(-1).time,true)} · 已计量 ${group.known}/${group.calls.length} 次`));tooltip.hidden=false;const rect=wrap.getBoundingClientRect();tooltip.style.left=Math.max(0,Math.min(rect.width-222,(event?.clientX||rect.left+30)-rect.left+12))+'px';tooltip.style.top='25px';};
      drawing.append(svg('circle',{cx:140,cy:140,r:94.5,fill:'none',stroke:'#29242f','stroke-width':33,class:'usage-donut-track'}));let angle=-Math.PI/2;
      groups.forEach(group=>{if(total>0&&valid(group.value)&&group.value>0){const end=angle+group.value/total*Math.PI*2,slice=svg('path',{d:ringPath(angle,end),class:'usage-donut-slice',tabindex:'0',role:'button','fill-rule':'evenodd','aria-label':`${providerName(group.providerId)} · ${group.label}，${display(group.value,metric)}，样本份额 ${(group.value/total*100).toFixed(1)}%`});slice.style.fill=color(group.key);slice.dataset.model=group.key;slice.addEventListener('pointerenter',event=>show(group,event));slice.addEventListener('pointerleave',hide);slice.addEventListener('focus',()=>show(group));slice.addEventListener('blur',hide);slice.addEventListener('click',()=>onSelect?.(group.key));slice.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect?.(group.key);}});slices.set(group.key,slice);drawing.append(slice);angle=end;}
        const item=node('li'),button=node('button'),name=node('span','name');button.type='button';button.dataset.focusId='usage-legend-'+group.key;button.style.setProperty('--model-color',color(group.key));button.setAttribute('aria-pressed',String(group.key===selectedModel));name.append(node('span','',group.label),node('small','',providerName(group.providerId)));button.append(node('span','swatch'),name,node('span','value',display(group.value,metric)),node('span','share',total>0&&valid(group.value)?(group.value/total*100).toFixed(1)+'%':'—'));button.addEventListener('pointerenter',event=>show(group,event));button.addEventListener('pointerleave',hide);button.addEventListener('focus',()=>show(group));button.addEventListener('blur',hide);button.addEventListener('click',()=>onSelect?.(group.key));item.append(button);legend.append(item);
      });
      const center=svg('text',{x:140,y:137,class:'usage-donut-center'}),value=svg('tspan',{x:140,class:'usage-donut-total'}),label=svg('tspan',{x:140,dy:25,class:'usage-donut-label'});value.textContent=total>0?(metric==='costUSD'?currency(total):new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(total)):knownCount?'0':'—';label.textContent=total>0?(metric==='tokens'?'已记录 Token':fields[metric]):knownCount?'记录值为 0':'暂无可统计用量';center.append(value,label);drawing.append(center);wrap.append(drawing,tooltip);body.append(wrap,legend);if(!groups.length)legend.append(node('li','conversation-empty','暂无近期调用'));
      const container=node('div','usage-distribution-content'),note=node('p','usage-sample-note','按当前范围已记录样本'+(knownCount<all.length?' · '+(all.length-knownCount)+' 次未计入':''));note.title=metric==='tokens'?'仅统计输入与输出均已提供的调用；缓存属于输入，推理属于输出，不重复相加。':'未知指标未计入样本份额。';container.append(body,note);if(total>0&&animate&&motion())play(drawing,[{opacity:.35},{opacity:1}],{duration:260,easing:'ease-out'});return container;
    });
  }
  window.AgentFlowUsage={chart,distribution,distributionGroups,modelKey,modelLabel,fields,valid,number,date,display};
})();

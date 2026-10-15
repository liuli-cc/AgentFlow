// Loaded before the vendor CLI. No credential is serialized or exported.
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';

const token=process.env.CODEBUDDY_AUTH_TOKEN;
const destinations=new WeakMap();
const constructing=[];
const rejected=()=>new Error('WorkBuddy authorization endpoint rejected.');
function containsToken(headers){
  if(!token||!headers)return false;
  try{
    const entries=typeof headers.entries==='function'?[...headers.entries()]:Object.entries(headers);
    return entries.some(([,value])=>String(value).includes(token));
  }catch{return false;}
}
function verify(url,headers){
  if(!containsToken(headers))return false;
  let parsed;try{parsed=new URL(url);}catch{throw rejected();}
  if(parsed.protocol!=='https:'||parsed.hostname!=='www.workbuddy.ai'||(parsed.port!==''&&parsed.port!=='443'))throw rejected();
  return true;
}
function requestValues(args,scheme){
  const first=args[0],isURL=typeof first==='string'||first instanceof URL;
  const options=isURL?(args[1]&&typeof args[1]==='object'?args[1]:{}):first||{};
  const hostname=options.hostname||options.host||'localhost';
  const port=options.port?':'+options.port:'';
  return {url:isURL?String(first):scheme+'//'+hostname+port+(options.path||'/'),headers:options.headers};
}
function verifyRequest(request,headers){
  // Unknown native constructors fail closed for authorization. A standard
  // request has its actual destination recorded before any header is accepted.
  return verify(destinations.get(request)||constructing.at(-1),headers);
}

if(globalThis.fetch){
  const original=globalThis.fetch;
  globalThis.fetch=function(input,options){
    const url=typeof input==='string'||input instanceof URL?String(input):input.url;
    const carriesToken=verify(url,options?.headers)|verify(url,input?.headers);
    // No redirect may forward a desktop authorization, even if the caller asks.
    const guarded=carriesToken?{...options,redirect:'error'}:options;
    return original.call(this,input,guarded);
  };
}
for(const [module,scheme] of [[http,'http:'],[https,'https:']]){
  const original=module.request;
  module.request=function(...args){
    const {url,headers}=requestValues(args,scheme);verify(url,headers);
    constructing.push(url);
    try{const request=original.apply(this,args);destinations.set(request,url);return request;}
    finally{constructing.pop();}
  };
  // Node's original get closes over the original request function.
  module.get=function(...args){const request=module.request(...args);request.end();return request;};
}
for(const method of ['setHeader','appendHeader']){
  const original=http.ClientRequest.prototype[method];
  if(typeof original!=='function')continue;
  http.ClientRequest.prototype[method]=function(name,value){verifyRequest(this,{[name]:value});return original.call(this,name,value);};
}
for(const method of ['write','end','flushHeaders']){
  const original=http.ClientRequest.prototype[method];
  if(typeof original!=='function')continue;
  http.ClientRequest.prototype[method]=function(...args){verifyRequest(this,this.getHeaders());return original.apply(this,args);};
}
syncBuiltinESMExports();

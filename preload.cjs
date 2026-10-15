'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const invoke=(name,...args)=>ipcRenderer.invoke('agentflow:'+name,...args);
contextBridge.exposeInMainWorld('agentflow',Object.freeze({
  getState:()=>invoke('getState'),chooseWorkspace:()=>invoke('chooseWorkspace'),saveConfig:c=>invoke('saveConfig',c),
  startRun:c=>invoke('startRun',c),controlRun:v=>invoke('controlRun',v),updateStage:v=>invoke('updateStage',v),getRun:id=>invoke('getRun',id),
  proposeWorkflow:c=>invoke('proposeWorkflow',c),confirmWorkflow:v=>invoke('confirmWorkflow',v),confirmResult:v=>invoke('confirmResult',v),
  deleteThread:v=>invoke('deleteThread',v),
  getConversation:v=>invoke('getConversation',v),
  copyConversation:v=>invoke('copyConversation',v),
  saveApiProvider:v=>invoke('saveApiProvider',v),removeApiProvider:id=>invoke('removeApiProvider',id),refreshApiModels:id=>invoke('refreshApiModels',id),
  refreshProviders:()=>invoke('refreshProviders'),testProvider:id=>invoke('testProvider',id),authenticateProvider:(id,methodId)=>invoke('authenticateProvider',id,methodId),cancelAuthentication:id=>invoke('cancelAuthentication',id),refreshTelemetry:()=>invoke('refreshTelemetry'),
  openProvider:id=>invoke('openProvider',id),prepareHandoff:v=>invoke('prepareHandoff',v),completeHandoff:v=>invoke('completeHandoff',v),
  exportRun:id=>invoke('exportRun',id),openWorkspace:p=>invoke('openWorkspace',p),copyText:text=>invoke('copyText',text),
  onState:callback=>{if(typeof callback!=='function')throw new Error('需要回调函数');const listener=(_event,state)=>callback(state);ipcRenderer.on('agentflow:state',listener);return()=>ipcRenderer.removeListener('agentflow:state',listener);}
}));

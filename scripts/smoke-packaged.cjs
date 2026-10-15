'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {NODE_VERSION}=require('./node-runtime.cjs');
function cleanEnvironment(){
  const env={...process.env};
  for(const name of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','AGENTFLOW_DATA_DIR','AGENTFLOW_SMOKE_TEST'])delete env[name];
  return env;
}
async function smokePackaged({app,expectedVersion=require('../package.json').version,timeoutMs=60000}={}){
  app=path.resolve(app);
  const mac=process.platform==='darwin';
  const executable=mac?path.join(app,'Contents/MacOS/AgentFlow'):path.join(app,'AgentFlow.exe');
  const resources=mac?path.join(app,'Contents/Resources'):path.join(app,'resources');
  const node=path.join(resources,mac?'node':'node.exe');
  for(const file of [executable,node,path.join(resources,'app.asar'),path.join(resources,'Node-LICENSE.txt')])if(!fs.statSync(file).isFile())throw new Error('Packaged startup resource is missing.');
  const env=cleanEnvironment();
  const runtime=JSON.parse(execFileSync(node,['-p','JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'],{env,encoding:'utf8',timeout:10000,windowsHide:true}));
  if(runtime.version!==NODE_VERSION||runtime.platform!==process.platform||runtime.arch!==process.arch)throw new Error('Bundled Node version/architecture does not match the native smoke runner.');
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-packaged-smoke-'));
  let child;
  try{
    const result=await new Promise((resolve,reject)=>{
      child=spawn(executable,[],{env:{...env,AGENTFLOW_DATA_DIR:dataDir,AGENTFLOW_SMOKE_TEST:'1'},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let closed=false;
      const timer=setTimeout(()=>{if(!closed){child.kill();reject(new Error('Packaged startup smoke test timed out.'));}},timeoutMs);
      child.stdout.resume();child.stderr.resume();
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',(code,signal)=>{closed=true;clearTimeout(timer);resolve({code,signal});});
    });
    if(result.code!==0)throw new Error('Packaged application exited unsuccessfully during startup smoke test.');
    const marker=JSON.parse(fs.readFileSync(path.join(dataDir,'smoke-result.json'),'utf8'));
    if(marker.ok!==true||marker.windowLoaded!==true||marker.version!==expectedVersion||marker.platform!==process.platform||marker.arch!==process.arch)throw new Error('Packaged application did not confirm the expected window/version/architecture.');
    const report={ok:true,version:marker.version,platform:marker.platform,arch:marker.arch,nodeVersion:runtime.version,windowLoaded:true};
    process.stdout.write(JSON.stringify(report)+'\n');return report;
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill();
    fs.rmSync(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
if(require.main===module){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--app'){process.stderr.write('Usage: npm run smoke:packaged -- --app <AgentFlow.app or Windows app directory>\n');process.exitCode=1;}
  else smokePackaged({app:args[1]}).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
}
module.exports={smokePackaged,cleanEnvironment};

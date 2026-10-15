'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {prepareNode,sha256,psLiteral}=require('./node-runtime.cjs');
const {buildTelemetry}=require('./build-telemetry.cjs');
const {createWindowsIcon}=require('./windows-icon.cjs');
const root=path.resolve(__dirname,'..');
const TARGETS=Object.freeze({'darwin-arm64':['zip','dmg'],'darwin-x64':['zip','dmg'],'win32-x64':['zip','exe']});
function parseArgs(args,{platform=process.platform,arch=process.arch}={}){
  const options={platform,arch,out:path.join(root,'release'),formats:null,plan:false,smoke:false};
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--plan')options.plan=true;
    else if(arg==='--smoke')options.smoke=true;
    else if(['--platform','--arch','--out','--formats'].includes(arg)){
      const value=args[++i];if(!value||value.startsWith('--'))throw new Error(`Missing value for ${arg}.`);
      options[arg.slice(2)]=arg==='--out'?path.resolve(value):arg==='--formats'?value.split(','):value;
    }else throw new Error(`Unknown build option: ${arg}`);
  }
  const allowed=TARGETS[`${options.platform}-${options.arch}`];
  if(!allowed)throw new Error('Supported targets: darwin arm64, darwin x64, win32 x64.');
  options.formats=options.formats||[...allowed];
  if(!options.formats.length||new Set(options.formats).size!==options.formats.length||options.formats.some(value=>!allowed.includes(value)))throw new Error('Invalid or repeated package format for this target.');
  if(options.out===root||root.startsWith(options.out+path.sep))throw new Error('Output must not replace the source directory or one of its parents.');
  return options;
}
function validateVersion(pkg,tag=process.env.AGENTFLOW_RELEASE_TAG){
  if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version)||!Number.isSafeInteger(pkg.buildNumber)||pkg.buildNumber<1)throw new Error('Package version/buildNumber is invalid.');
  if(tag&&tag!==`v${pkg.version}`)throw new Error('Release tag must exactly match package.json version.');
}
function artifactStem(pkg,{platform,arch}){return `AgentFlow-${pkg.version}-${platform==='darwin'?'macOS':'Windows'}-${arch}`;}
function copyPublicTree(source,destination,{exclude=new Set()}={}){
  fs.mkdirSync(destination,{recursive:true,mode:0o755});
  for(const entry of fs.readdirSync(source,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    if(exclude.has(entry.name))continue;
    const from=path.join(source,entry.name),to=path.join(destination,entry.name);
    if(entry.isSymbolicLink())throw new Error('Source staging refuses symbolic links.');
    if(entry.isDirectory())copyPublicTree(from,to);
    else if(entry.isFile()){fs.copyFileSync(from,to);fs.chmodSync(to,0o644);}
    else throw new Error('Source staging refuses special files.');
  }
}
function stageSource(source,stage,pkg){
  fs.mkdirSync(stage,{recursive:true});
  for(const name of ['main.cjs','preload.cjs','LICENSE','THIRD_PARTY_NOTICES.md'])fs.copyFileSync(path.join(source,name),path.join(stage,name));
  const runtimePackage={name:pkg.name,productName:pkg.productName,version:pkg.version,buildNumber:pkg.buildNumber,description:pkg.description,main:pkg.main,author:pkg.author,license:pkg.license,private:true};
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify(runtimePackage,null,2)+'\n');
  copyPublicTree(path.join(source,'lib'),path.join(stage,'lib'),{exclude:new Set(['tokenlens-sources'])});
  copyPublicTree(path.join(source,'ui'),path.join(stage,'ui'));
  fs.mkdirSync(path.join(stage,'assets'));
  for(const name of ['icon.png','icon.icns','Electron-LICENSE.txt','TokenLens-LICENSE.txt','LICENSES.chromium.html'])fs.copyFileSync(path.join(source,'assets',name),path.join(stage,'assets',name));
}
function createZip({platform,source,output}){
  if(platform==='darwin')execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',source,output],{stdio:'inherit'});
  else execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Compress-Archive -Path ${psLiteral(source)} -DestinationPath ${psLiteral(output)} -CompressionLevel Optimal -Force`],{stdio:'inherit'});
}
function createDMG({app,output,scratch}){
  fs.mkdirSync(scratch,{recursive:true});
  execFileSync('/usr/bin/ditto',[app,path.join(scratch,'AgentFlow.app')],{stdio:'inherit'});
  fs.symlinkSync('/Applications',path.join(scratch,'Applications'));
  execFileSync('/usr/bin/hdiutil',['create','-volname','AgentFlow','-srcfolder',scratch,'-ov','-format','UDZO',output],{stdio:'inherit'});
}
function writeChecksums(out){
  const names=fs.readdirSync(out).filter(name=>/^AgentFlow-.*\.(?:zip|dmg|exe|build\.json)$/.test(name)&&fs.statSync(path.join(out,name)).isFile()).sort();
  fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),names.map(name=>`${sha256(fs.readFileSync(path.join(out,name)))}  ${name}`).join('\n')+'\n');
  return names;
}
async function build(options){
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));validateVersion(pkg);
  const stem=artifactStem(pkg,options);
  if(options.plan)return {version:pkg.version,buildNumber:pkg.buildNumber,target:`${options.platform}-${options.arch}`,formats:options.formats,files:options.formats.map(format=>`${stem}${format==='exe'?'-Setup':''}.${format}`),bundledNode:require('./node-runtime.cjs').NODE_VERSION};
  if(process.platform!==options.platform)throw new Error('Build installers on their native OS; use the GitHub Actions build matrix for other systems.');
  const target=`${options.platform}-${options.arch}`,scratch=path.join(options.out,'.build',target);
  fs.mkdirSync(options.out,{recursive:true});fs.rmSync(scratch,{recursive:true,force:true});fs.mkdirSync(scratch,{recursive:true});
  const stage=path.join(scratch,'source');stageSource(root,stage,pkg);
  const resources=path.join(scratch,'resources');
  const node=await prepareNode({platform:options.platform,arch:options.arch,cacheDir:path.join(options.out,'.cache','node'),outputDir:resources});
  const extraResource=[node.executable,node.license];
  if(options.platform==='darwin')extraResource.push(buildTelemetry({arch:options.arch,output:path.join(resources,'tokenlens-telemetry'),root}));
  const icon=options.platform==='darwin'?path.join(root,'assets/icon.icns'):createWindowsIcon(path.join(root,'assets/icon.png'),path.join(scratch,'icon.ico'));
  const {packager}=await import('@electron/packager');
  const results=await packager({dir:stage,out:path.join(scratch,'package'),name:'AgentFlow',appBundleId:'cn.liuli.agentflow',
    appVersion:pkg.version,buildVersion:options.platform==='darwin'?String(pkg.buildNumber):`${pkg.version}.${pkg.buildNumber}`,
    electronVersion:pkg.devDependencies.electron,platform:options.platform,arch:options.arch,icon,extraResource,
    overwrite:true,prune:true,asar:true,download:{rejectUnauthorized:true},
    appCopyright:'Copyright © 2026 AgentFlow contributors',win32metadata:{CompanyName:'AgentFlow contributors',FileDescription:'AgentFlow',ProductName:'AgentFlow',InternalName:'AgentFlow',OriginalFilename:'AgentFlow.exe'}});
  const directory=results[0],app=options.platform==='darwin'?path.join(directory,'AgentFlow.app'):directory;
  const resourcePath=options.platform==='darwin'?path.join(app,'Contents/Resources'):path.join(app,'resources');
  if(!fs.existsSync(path.join(resourcePath,options.platform==='darwin'?'node':'node.exe')))throw new Error('Bundled Node was not copied to the runtime resource directory.');
  if(options.platform==='darwin'){
    execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',app],{stdio:'inherit'});
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
  }
  if(options.smoke)await require('./smoke-packaged.cjs').smokePackaged({app,expectedVersion:pkg.version});
  const files=[];
  // Squirrel adds Squirrel.exe to its source directory; make the portable archive first.
  if(options.formats.includes('zip')){const output=path.join(options.out,stem+'.zip');fs.rmSync(output,{force:true});createZip({platform:options.platform,source:app,output});files.push(path.basename(output));}
  if(options.formats.includes('dmg')){const output=path.join(options.out,stem+'.dmg');createDMG({app,output,scratch:path.join(scratch,'dmg')});files.push(path.basename(output));}
  if(options.formats.includes('exe')){
    const {createWindowsInstaller}=require('electron-winstaller');
    const installerDir=path.join(scratch,'installer'),filename=stem+'-Setup.exe';
    await createWindowsInstaller({appDirectory:directory,outputDirectory:installerDir,name:'AgentFlow',title:'AgentFlow',exe:'AgentFlow.exe',authors:pkg.author,version:pkg.version,description:pkg.description,setupExe:filename,setupIcon:icon,noMsi:true,noDelta:true});
    fs.copyFileSync(path.join(installerDir,filename),path.join(options.out,filename));files.push(filename);
  }
  const manifest={product:'AgentFlow',version:pkg.version,buildNumber:pkg.buildNumber,platform:options.platform,arch:options.arch,electronVersion:pkg.devDependencies.electron,nodeVersion:node.version,nodeArchiveSHA256:node.archiveSHA256,signing:options.platform==='darwin'?'ad-hoc (not notarized)':'unsigned',files:files.map(name=>({name,sha256:sha256(fs.readFileSync(path.join(options.out,name))),bytes:fs.statSync(path.join(options.out,name)).size}))};
  fs.writeFileSync(path.join(options.out,stem+'.build.json'),JSON.stringify(manifest,null,2)+'\n');
  writeChecksums(options.out);
  return {app,files,manifest:path.join(options.out,stem+'.build.json')};
}
if(require.main===module)build(parseArgs(process.argv.slice(2))).then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
module.exports={TARGETS,parseArgs,validateVersion,artifactStem,copyPublicTree,stageSource,writeChecksums,build};

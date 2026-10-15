'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {sha256}=require('./node-runtime.cjs');
const {validateVersion,writeChecksums}=require('./package.cjs');
function safeName(name){return typeof name==='string'&&/^AgentFlow-[A-Za-z0-9.-]+\.(zip|dmg|exe|build\.json)$/.test(name)&&!name.includes('..');}
function verifyArtifacts({dir,write=false,pkg=require('../package.json'),requireAll=false}={}){
  validateVersion(pkg);dir=path.resolve(dir);
  const manifests=fs.readdirSync(dir).filter(name=>name.endsWith('.build.json'));
  if(!manifests.length)throw new Error('No build manifests found.');
  const targets=new Set(),expected=new Set();
  for(const name of manifests){
    if(!safeName(name))throw new Error('Invalid build manifest filename.');
    if(!fs.lstatSync(path.join(dir,name)).isFile()||fs.lstatSync(path.join(dir,name)).isSymbolicLink())throw new Error('Build manifest must be a regular file.');
    const manifest=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
    if(manifest.product!=='AgentFlow'||manifest.version!==pkg.version||manifest.buildNumber!==pkg.buildNumber)throw new Error('Artifact version/buildNumber mismatch.');
    const target=`${manifest.platform}-${manifest.arch}`;
    if(!require('./package.cjs').TARGETS[target]||targets.has(target))throw new Error('Duplicate or invalid build target.');targets.add(target);expected.add(name);
    const runtime=require('./node-runtime.cjs');
    if(manifest.electronVersion!==pkg.devDependencies.electron||manifest.nodeVersion!==runtime.NODE_VERSION||manifest.nodeArchiveSHA256!==runtime.NODE_ARCHIVES[target].sha256)throw new Error('Artifact runtime version or integrity pin mismatch.');
    if(!Array.isArray(manifest.files)||!manifest.files.length)throw new Error('Manifest has no distributable files.');
    const formats=new Set();
    for(const file of manifest.files){
      if(!safeName(file.name)||expected.has(file.name)||!file.name.startsWith(`AgentFlow-${pkg.version}-${manifest.platform==='darwin'?'macOS':'Windows'}-${manifest.arch}`))throw new Error('Invalid artifact entry.');
      const full=path.join(dir,file.name),stat=fs.lstatSync(full);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.bytes||sha256(fs.readFileSync(full))!==file.sha256)throw new Error('Artifact integrity check failed.');
      formats.add(path.extname(file.name).slice(1));expected.add(file.name);
    }
    if(requireAll&&require('./package.cjs').TARGETS[target].some(format=>!formats.has(format)))throw new Error('A release target is missing an installer or ZIP.');
  }
  if(requireAll&&targets.size!==3)throw new Error('A release must contain all three supported targets.');
  if(write)writeChecksums(dir);
  const lines=fs.readFileSync(path.join(dir,'SHA256SUMS.txt'),'utf8').trim().split(/\r?\n/),seen=new Set();
  for(const line of lines){
    const match=/^([a-f0-9]{64})  (.+)$/.exec(line);
    if(!match||!safeName(match[2])||seen.has(match[2])||!expected.has(match[2]))throw new Error('Invalid checksum manifest.');
    const file=path.join(dir,match[2]);if(!fs.lstatSync(file).isFile()||sha256(fs.readFileSync(file))!==match[1])throw new Error('SHA-256 checksum mismatch.');seen.add(match[2]);
  }
  if(seen.size!==expected.size)throw new Error('Checksum manifest is incomplete.');
  return {ok:true,version:pkg.version,buildNumber:pkg.buildNumber,targets:[...targets].sort(),files:seen.size};
}
if(require.main===module){
  try{
    const args=process.argv.slice(2);let dir=path.resolve(__dirname,'../release'),write=false,requireAll=false;
    for(let i=0;i<args.length;i++){
      if(args[i]==='--dir'){dir=args[++i];if(!dir)throw new Error('Missing --dir value.');}
      else if(args[i]==='--write-checksums')write=true;
      else if(args[i]==='--require-all')requireAll=true;
      else throw new Error('Unknown artifact verification option.');
    }
    process.stdout.write(JSON.stringify(verifyArtifacts({dir,write,requireAll}),null,2)+'\n');
  }catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
module.exports={safeName,verifyArtifacts};

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {parseArgs,validateVersion,artifactStem,stageSource,writeChecksums}=require('./package.cjs');
const {verifyArtifacts}=require('./verify-artifacts.cjs');
const {NODE_VERSION,NODE_ARCHIVES,sha256,verifyArchive,verifyExecutable,downloadOfficial}=require('./node-runtime.cjs');
const {createWindowsIcon,decodePNG}=require('./windows-icon.cjs');
const pkg=require('../package.json');
function scratch(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentflow-package-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('build targets, formats and version/tag validation are exact',()=>{
  for(const [platform,arch] of [['darwin','arm64'],['darwin','x64'],['win32','x64']]){
    const options=parseArgs(['--platform',platform,'--arch',arch,'--plan']);
    assert.equal(options.plan,true);assert.equal(options.formats.length,2);
    assert.match(artifactStem(pkg,options),platform==='darwin'?/macOS/:/Windows/);
  }
  for(const args of [['--platform','linux'],['--platform','win32','--arch','arm64'],['--formats','exe'],['--formats','zip,zip'],['--out',path.resolve(__dirname,'..')],['--unknown'],['--out']])assert.throws(()=>parseArgs(args,{platform:'darwin',arch:'arm64'}));
  validateVersion(pkg,`v${pkg.version}`);assert.throws(()=>validateVersion(pkg,'v0.0.0'));assert.throws(()=>validateVersion({...pkg,buildNumber:0}));
});
test('source staging excludes accounts, downloaded runtimes, tests and native source',t=>{
  const dir=scratch(t),source=path.join(dir,'source'),stage=path.join(dir,'staged');fs.mkdirSync(source);
  for(const name of ['main.cjs','preload.cjs','LICENSE','THIRD_PARTY_NOTICES.md'])fs.writeFileSync(path.join(source,name),'public');
  for(const name of ['lib','ui','assets','test','.codex','runtimes','release'])fs.mkdirSync(path.join(source,name));
  fs.mkdirSync(path.join(source,'lib/tokenlens-sources'));fs.writeFileSync(path.join(source,'lib/tokenlens-sources/private.swift'),'not-runtime');
  fs.writeFileSync(path.join(source,'lib/engine.cjs'),'runtime');fs.writeFileSync(path.join(source,'ui/app.js'),'ui');
  for(const name of ['icon.png','icon.icns','Electron-LICENSE.txt','TokenLens-LICENSE.txt','LICENSES.chromium.html'])fs.writeFileSync(path.join(source,'assets',name),'public');
  fs.writeFileSync(path.join(source,'assets/tokenlens-telemetry'),'wrong-architecture');fs.writeFileSync(path.join(source,'.codex/auth.json'),'SYNTHETIC_SECRET');
  fs.writeFileSync(path.join(source,'runtimes/private-cli'),'SYNTHETIC_SECRET');stageSource(source,stage,pkg);
  assert.deepEqual(fs.readdirSync(stage).sort(),['LICENSE','THIRD_PARTY_NOTICES.md','assets','lib','main.cjs','package.json','preload.cjs','ui']);
  assert.deepEqual(fs.readdirSync(path.join(stage,'lib')),['engine.cjs']);assert.equal(fs.existsSync(path.join(stage,'assets/tokenlens-telemetry')),false);
  const runtime=JSON.parse(fs.readFileSync(path.join(stage,'package.json')));assert.equal(runtime.version,pkg.version);assert.equal(runtime.buildNumber,pkg.buildNumber);assert.equal(runtime.devDependencies,undefined);
  if(process.platform!=='win32'){
    fs.symlinkSync(path.join(source,'.codex/auth.json'),path.join(source,'lib/leak.cjs'));
    assert.throws(()=>stageSource(source,path.join(dir,'rejected'),pkg),/symbolic/);
  }
});
test('official Node downloads reject wrong origin, redirects, corruption and oversized bodies',async()=>{
  for(const url of ['http://nodejs.org/file','https://example.org/file','https://nodejs.org:8443/file','https://a@nodejs.org/file','https://nodejs.org/file?q=1'])await assert.rejects(downloadOfficial(url),/official/);
  let options;
  const result=await downloadOfficial('https://nodejs.org/file',{fetchImpl:async(_url,input)=>{options=input;return new Response(Buffer.from('official'));}});
  assert.equal(options.redirect,'error');assert.equal(result.toString(),'official');
  await assert.rejects(downloadOfficial('https://nodejs.org/file',{maxBytes:2,fetchImpl:async()=>new Response(Buffer.from('long'))}),/size/);
  await assert.rejects(downloadOfficial('https://nodejs.org/file',{fetchImpl:async()=>new Response(null,{status:403})}),/403/);
  verifyArchive(Buffer.from('data'),sha256(Buffer.from('data')));assert.throws(()=>verifyArchive(Buffer.from('corrupt'),'0'.repeat(64)),/mismatch/);
  assert.equal(Object.keys(NODE_ARCHIVES).length,3);for(const spec of Object.values(NODE_ARCHIVES)){assert.match(spec.sha256,/^[a-f0-9]{64}$/);assert.ok(spec.name.includes(NODE_VERSION));}
});
test('bundled runtime format verifies the actual architecture',()=>{
  const macho=Buffer.alloc(32);macho.writeUInt32LE(0xfeedfacf);macho.writeUInt32LE(0x100000c,4);
  verifyExecutable(macho,'darwin','arm64');assert.throws(()=>verifyExecutable(macho,'darwin','x64'),/architecture/);
  const pe=Buffer.alloc(256);pe.writeUInt16LE(0x5a4d);pe.writeUInt32LE(128,0x3c);pe.write('PE\u0000\u0000',128,'binary');pe.writeUInt16LE(0x8664,132);
  verifyExecutable(pe,'win32','x64');pe.writeUInt16LE(0xaa64,132);assert.throws(()=>verifyExecutable(pe,'win32','x64'),/architecture/);
});
test('Windows icon contains six PNG sizes derived from the supplied artwork',t=>{
  const output=path.join(scratch(t),'icon.ico');createWindowsIcon(path.resolve(__dirname,'../assets/icon.png'),output);
  const ico=fs.readFileSync(output);assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),6);
  for(let i=0;i<6;i++){
    const at=6+16*i,width=ico[at]||256,length=ico.readUInt32LE(at+8),offset=ico.readUInt32LE(at+12),image=decodePNG(ico.subarray(offset,offset+length));
    assert.equal(image.width,width);assert.equal(image.height,width);assert.equal(image.channels,4);
  }
});
function makeArtifact(dir,platform='darwin',arch='arm64'){
  const stem=artifactStem(pkg,{platform,arch}),name=stem+'.zip',bytes=Buffer.from('synthetic distributable');fs.writeFileSync(path.join(dir,name),bytes);
  const manifest={product:'AgentFlow',version:pkg.version,buildNumber:pkg.buildNumber,platform,arch,electronVersion:pkg.devDependencies.electron,nodeVersion:NODE_VERSION,nodeArchiveSHA256:NODE_ARCHIVES[`${platform}-${arch}`].sha256,files:[{name,sha256:sha256(bytes),bytes:bytes.length}]};
  const manifestFile=path.join(dir,stem+'.build.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest));return {name,manifest,manifestFile};
}
test('release verifier detects corruption, incomplete checksums and version mismatches',t=>{
  const dir=scratch(t),entry=makeArtifact(dir);writeChecksums(dir);assert.equal(verifyArtifacts({dir,pkg}).ok,true);
  assert.throws(()=>verifyArtifacts({dir,pkg,requireAll:true}),/installer|ZIP/);
  fs.appendFileSync(path.join(dir,entry.name),'bad');assert.throws(()=>verifyArtifacts({dir,pkg}),/integrity/);
  fs.writeFileSync(path.join(dir,entry.name),'synthetic distributable');fs.writeFileSync(path.join(dir,'SHA256SUMS.txt'),'');assert.throws(()=>verifyArtifacts({dir,pkg}),/checksum/);
  writeChecksums(dir);entry.manifest.buildNumber++;fs.writeFileSync(entry.manifestFile,JSON.stringify(entry.manifest));assert.throws(()=>verifyArtifacts({dir,pkg}),/version/);
});
test('release verifier refuses traversal, symlinks and unreviewed runtime pins',t=>{
  const dir=scratch(t),entry=makeArtifact(dir);writeChecksums(dir);
  entry.manifest.files[0].name='../outside.zip';fs.writeFileSync(entry.manifestFile,JSON.stringify(entry.manifest));assert.throws(()=>verifyArtifacts({dir,pkg}),/entry/);
  entry.manifest.files[0].name=entry.name;entry.manifest.nodeArchiveSHA256='0'.repeat(64);fs.writeFileSync(entry.manifestFile,JSON.stringify(entry.manifest));assert.throws(()=>verifyArtifacts({dir,pkg}),/runtime/);
  if(process.platform!=='win32'){
    entry.manifest.nodeArchiveSHA256=NODE_ARCHIVES['darwin-arm64'].sha256;fs.writeFileSync(entry.manifestFile,JSON.stringify(entry.manifest));fs.renameSync(path.join(dir,entry.name),path.join(dir,'outside'));fs.symlinkSync(path.join(dir,'outside'),path.join(dir,entry.name));assert.throws(()=>verifyArtifacts({dir,pkg}),/integrity/);
  }
});

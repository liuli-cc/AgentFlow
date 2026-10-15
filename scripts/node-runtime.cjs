'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
// Pinned against https://nodejs.org/dist/v22.22.3/SHASUMS256.txt.
// A version update must update these reviewed hashes, not trust a new manifest alone.
const NODE_VERSION='22.22.3';
const NODE_ARCHIVES=Object.freeze({
  'darwin-arm64':{name:`node-v${NODE_VERSION}-darwin-arm64.tar.gz`,sha256:'0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207'},
  'darwin-x64':{name:`node-v${NODE_VERSION}-darwin-x64.tar.gz`,sha256:'45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec'},
  'win32-x64':{name:`node-v${NODE_VERSION}-win-x64.zip`,sha256:'6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33'},
});
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
async function downloadOfficial(url,{maxBytes=100*1024*1024,fetchImpl=global.fetch}={}){
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.hostname!=='nodejs.org'||parsed.port||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('Node downloads must use the exact official HTTPS origin.');
  const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw new Error(`Official Node download failed (${response.status}).`);
  if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('Official Node download exceeded the size limit.');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw new Error('Official Node download exceeded the size limit.');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
function verifyArchive(bytes,expected){
  if(sha256(bytes)!==expected)throw new Error('Node runtime SHA-256 mismatch; refusing to package it.');
}
function verifyExecutable(bytes,platform,arch){
  if(platform==='win32'){
    if(bytes.length<256||bytes.readUInt16LE(0)!==0x5a4d)throw new Error('Invalid Windows Node executable.');
    const offset=bytes.readUInt32LE(0x3c);
    if(offset>bytes.length-6||bytes.toString('binary',offset,offset+4)!=='PE\u0000\u0000'||bytes.readUInt16LE(offset+4)!==0x8664)throw new Error('Wrong Windows Node architecture.');
  }else{
    if(bytes.length<32||bytes.readUInt32LE(0)!==0xfeedfacf||bytes.readUInt32LE(4)!==({arm64:0x100000c,x64:0x1000007}[arch]))throw new Error('Wrong macOS Node architecture.');
  }
}
function psLiteral(value){return "'"+value.replaceAll("'","''")+"'";}
async function prepareNode({platform,arch,cacheDir,outputDir,fetchImpl}={}){
  const spec=NODE_ARCHIVES[`${platform}-${arch}`];
  if(!spec)throw new Error('Unsupported bundled Node target.');
  fs.mkdirSync(cacheDir,{recursive:true});fs.mkdirSync(outputDir,{recursive:true});
  const base=`https://nodejs.org/dist/v${NODE_VERSION}/`;
  const manifest=(await downloadOfficial(base+'SHASUMS256.txt',{maxBytes:100000,fetchImpl})).toString('utf8');
  if(!manifest.split(/\r?\n/).some(line=>line===`${spec.sha256}  ${spec.name}`))throw new Error('The official Node manifest does not match the reviewed hash.');
  const archive=path.join(cacheDir,spec.name);
  let bytes;
  if(fs.existsSync(archive)){bytes=fs.readFileSync(archive);verifyArchive(bytes,spec.sha256);}
  else{
    bytes=await downloadOfficial(base+spec.name,{fetchImpl});verifyArchive(bytes,spec.sha256);
    const temporary=archive+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,bytes,{mode:0o600});fs.renameSync(temporary,archive);
  }
  const scratch=fs.mkdtempSync(path.join(outputDir,'extract-'));
  try{
    const stem=spec.name.replace(/\.tar\.gz$|\.zip$/,'');
    let source;
    if(platform==='darwin'){
      execFileSync('/usr/bin/tar',['-xzf',archive,'-C',scratch,`${stem}/bin/node`,`${stem}/LICENSE`],{stdio:'inherit'});
      source=path.join(scratch,stem,'bin/node');
    }else{
      if(process.platform!=='win32')throw new Error('Windows runtime extraction requires a Windows build host.');
      // Extract only two exact, integrity-pinned entries. Expanding the complete
      // npm tree is unnecessary and can exceed legacy Windows path limits.
      fs.mkdirSync(path.join(scratch,stem));
      const selected=['node.exe','LICENSE'].map(name=>`$entry=$zip.GetEntry(${psLiteral(stem+'/'+name)}); if($null -eq $entry){throw 'Missing official Node archive entry'}; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry,${psLiteral(path.join(scratch,stem,name))},$false)`).join('; ');
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[System.IO.Compression.ZipFile]::OpenRead(${psLiteral(archive)}); try { ${selected} } finally { $zip.Dispose() }`],{stdio:'inherit'});
      source=path.join(scratch,stem,'node.exe');
    }
    const executable=path.join(outputDir,platform==='win32'?'node.exe':'node');
    const binary=fs.readFileSync(source);verifyExecutable(binary,platform,arch);
    fs.writeFileSync(executable,binary,{mode:0o755});fs.chmodSync(executable,0o755);
    const license=path.join(outputDir,'Node-LICENSE.txt');fs.copyFileSync(path.join(scratch,stem,'LICENSE'),license);
    return {executable,license,version:NODE_VERSION,archiveSHA256:spec.sha256};
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
module.exports={NODE_VERSION,NODE_ARCHIVES,sha256,downloadOfficial,verifyArchive,verifyExecutable,prepareNode,psLiteral};

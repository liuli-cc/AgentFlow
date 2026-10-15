'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');
const {verifyArtifacts}=require('./verify-artifacts.cjs');
const {validateVersion}=require('./package.cjs');
const pkg=require('../package.json');
function publishRelease({dir=path.resolve(__dirname,'../release'),tag=process.env.AGENTFLOW_RELEASE_TAG}={}){
  if(!tag)throw new Error('Missing release tag.');validateVersion(pkg,tag);
  verifyArtifacts({dir,write:true,requireAll:true});
  const current=spawnSync('gh',['release','view',tag,'--json','isDraft'],{encoding:'utf8',shell:false});
  if(current.status===0){if(JSON.parse(current.stdout).isDraft!==true)throw new Error('Refusing to replace an already published release.');}
  else execFileSync('gh',['release','create',tag,'--verify-tag','--draft','--title',`AgentFlow ${pkg.version}`,'--notes-file',path.resolve(__dirname,'../docs/release-notes.md'),...(pkg.version.includes('-')?['--prerelease']:[])],{stdio:'inherit'});
  const files=fs.readdirSync(dir).filter(name=>name==='SHA256SUMS.txt'||name.startsWith('AgentFlow-')&&/\.(zip|dmg|exe|build\.json)$/.test(name)).sort().map(name=>path.join(dir,name));
  execFileSync('gh',['release','upload',tag,...files,'--clobber'],{stdio:'inherit'});
  execFileSync('gh',['release','edit',tag,'--draft=false'],{stdio:'inherit'});
}
if(require.main===module){try{publishRelease();}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}}
module.exports={publishRelease};

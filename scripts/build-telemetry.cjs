'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
function buildTelemetry({arch=process.arch,output,root=path.resolve(__dirname,'..')}={}){
  if(process.platform!=='darwin')throw new Error('The optional macOS telemetry helper must be compiled on macOS.');
  const target={arm64:'arm64',x64:'x86_64'}[arch];
  if(!target)throw new Error('Unsupported telemetry architecture.');
  output=path.resolve(output||path.join(root,'assets/tokenlens-telemetry'));
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const sdk=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim();
  const source=path.join(root,'lib/tokenlens-sources');
  const files=fs.readdirSync(source).filter(name=>name.endsWith('.swift')).sort().map(name=>path.join(source,name));
  if(!files.length)throw new Error('Missing telemetry Swift sources.');
  execFileSync('/usr/bin/xcrun',['--sdk','macosx','swiftc','-sdk',sdk,'-swift-version','6','-strict-concurrency=complete','-parse-as-library','-O','-target',`${target}-apple-macosx14.0`,...files,'-o',output],{stdio:'inherit'});
  fs.chmodSync(output,0o755);
  execFileSync('/usr/bin/codesign',['--force','--sign','-',output],{stdio:'inherit'});
  return output;
}
if(require.main===module){
  try{
    const args=process.argv.slice(2);let arch=process.arch,output;
    for(let i=0;i<args.length;i++){
      if(args[i]==='--arch')arch=args[++i];
      else if(args[i]==='--out')output=args[++i];
      else throw new Error(`Unknown telemetry option: ${args[i]}`);
    }
    process.stdout.write(buildTelemetry({arch,output})+'\n');
  }catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
module.exports={buildTelemetry};

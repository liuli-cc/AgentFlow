'use strict';
// Resolve the files ourselves: Windows shells do not expand POSIX globs.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const files=['test','scripts'].flatMap(dir=>fs.readdirSync(path.join(root,dir)).filter(name=>name.endsWith('.test.cjs')).sort().map(name=>path.join(root,dir,name)));
const result=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit',shell:false});
if(result.error)throw result.error;
process.exitCode=result.status===null?1:result.status;

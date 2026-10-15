'use strict';
// Preserve the supplied artwork and scale. Align its visible bounds, rather
// than the screenshot canvas, to the center of the native icon tile.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const source=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'assets/icon-source.png');
const assets=path.join(root,'assets');
const scratchRoot=path.resolve(root,'../../work');
fs.mkdirSync(scratchRoot,{recursive:true});
const scratch=fs.mkdtempSync(path.join(scratchRoot,'agentflow-icon-'));
const iconset=path.join(scratch,'AgentFlow.iconset');fs.mkdirSync(iconset);
const centered=path.join(scratch,'centered.png');
if(source!==path.join(assets,'icon-source.png'))fs.copyFileSync(source,path.join(assets,'icon-source.png'));
const layout=JSON.parse(execFileSync('/usr/bin/swift',[path.join(__dirname,'layout-icon.swift'),source,centered],{encoding:'utf8'}));
for(const [name,size]of [
  ['icon_16x16.png',16],['icon_16x16@2x.png',32],['icon_32x32.png',32],['icon_32x32@2x.png',64],
  ['icon_128x128.png',128],['icon_128x128@2x.png',256],['icon_256x256.png',256],['icon_256x256@2x.png',512],
  ['icon_512x512.png',512],['icon_512x512@2x.png',1024],
])execFileSync('/usr/bin/sips',['--resampleHeightWidth',String(size),String(size),centered,'--out',path.join(iconset,name)],{stdio:'ignore'});
fs.copyFileSync(path.join(iconset,'icon_512x512@2x.png'),path.join(assets,'icon.png'));
execFileSync('/usr/bin/iconutil',['--convert','icns','--output',path.join(assets,'icon.icns'),iconset],{stdio:'inherit'});
process.stdout.write(JSON.stringify({source,...layout,iconset,iconPNG:path.join(assets,'icon.png'),icns:path.join(assets,'icon.icns')})+'\n');

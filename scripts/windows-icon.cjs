'use strict';
// Re-containerize the supplied PNG artwork. No generated or replacement artwork.
const fs=require('node:fs');
const zlib=require('node:zlib');
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function chunk(type,bytes){const label=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([label,bytes])));return Buffer.concat([length,label,bytes,crc]);}
function decodePNG(png){
  if(!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Icon is not a PNG.');
  let width,height,channels;const parts=[];
  for(let offset=8;offset+12<=png.length;){
    const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8),bytes=png.subarray(offset+8,offset+8+length);
    if(offset+12+length>png.length||crc32(png.subarray(offset+4,offset+8+length))!==png.readUInt32BE(offset+8+length))throw new Error('Corrupt icon PNG.');
    if(type==='IHDR'){
      width=bytes.readUInt32BE(0);height=bytes.readUInt32BE(4);channels=bytes[9]===6?4:bytes[9]===2?3:0;
      if(bytes[8]!==8||!channels||bytes[10]||bytes[11]||bytes[12]||!width||width>4096||!height||height>4096)throw new Error('Icon must be a non-interlaced 8-bit RGB/RGBA PNG.');
    }else if(type==='IDAT')parts.push(bytes);
    offset+=12+length;if(type==='IEND')break;
  }
  if(!width||width!==height)throw new Error('Icon artwork must be square.');
  const stride=width*channels,raw=zlib.inflateSync(Buffer.concat(parts),{maxOutputLength:(stride+1)*height});
  if(raw.length!==(stride+1)*height)throw new Error('Invalid icon pixel length.');
  const pixels=Buffer.alloc(stride*height);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)];if(filter>4)throw new Error('Invalid PNG filter.');
    for(let x=0;x<stride;x++){
      const a=x>=channels?pixels[y*stride+x-channels]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=channels?pixels[(y-1)*stride+x-channels]:0;
      pixels[y*stride+x]=(raw[y*(stride+1)+1+x]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;
    }
  }
  return {width,height,channels,pixels};
}
function resizePNG(source,size){
  const {width,channels,pixels}=source,rows=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const x0=Math.floor(x*width/size),x1=Math.max(x0+1,Math.floor((x+1)*width/size));
    const y0=Math.floor(y*width/size),y1=Math.max(y0+1,Math.floor((y+1)*width/size));
    let alpha=0,red=0,green=0,blue=0,count=0;
    for(let sy=y0;sy<y1;sy++)for(let sx=x0;sx<x1;sx++){
      const at=(sy*width+sx)*channels,a=channels===4?pixels[at+3]:255;
      alpha+=a;red+=pixels[at]*a;green+=pixels[at+1]*a;blue+=pixels[at+2]*a;count++;
    }
    const at=y*(size*4+1)+1+x*4;
    rows[at]=alpha?Math.round(red/alpha):0;rows[at+1]=alpha?Math.round(green/alpha):0;rows[at+2]=alpha?Math.round(blue/alpha):0;rows[at+3]=Math.round(alpha/count);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
function createWindowsIcon(input,output){
  const source=decodePNG(fs.readFileSync(input)),sizes=[16,32,48,64,128,256],images=sizes.map(size=>resizePNG(source,size));
  const header=Buffer.alloc(6+16*images.length);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);let offset=header.length;
  for(let i=0;i<images.length;i++){
    const at=6+i*16;header[at]=sizes[i]===256?0:sizes[i];header[at+1]=header[at];header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(images[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=images[i].length;
  }
  fs.writeFileSync(output,Buffer.concat([header,...images]));return output;
}
module.exports={createWindowsIcon,decodePNG,resizePNG};

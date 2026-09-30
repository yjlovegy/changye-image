import type { Pixels } from './inpaintComposite';

/** Separate detected people/eyes so one crop cannot repaint all subjects together. */
export function detailRegions(mask: Pixels, limit = 6) {
  const {width,height,data}=mask, total=width*height;
  if (total>16_000_000) throw new Error('局部细节图片超过 1600 万像素');
  const labels=new Uint16Array(total), queue=new Int32Array(total);
  const regions:{id:number;area:number;x:number;y:number;width:number;height:number}[]=[];
  let id=0;
  for(let start=0;start<total;start++) {
    if(labels[start] || data[start*4]<26)continue;
    if(++id>=65535)throw new Error('检测区域过于零散，已跳过局部细节处理');
    let head=0,tail=1,minX=width,minY=height,maxX=0,maxY=0;
    queue[0]=start;labels[start]=id;
    while(head<tail){
      const pos=queue[head++],x=pos%width,y=Math.floor(pos/width);
      minX=Math.min(x,minX);maxX=Math.max(x,maxX);minY=Math.min(y,minY);maxY=Math.max(y,maxY);
      const visit=(n:number)=>{if(!labels[n]&&data[n*4]>=26){labels[n]=id;queue[tail++]=n;}};
      if(x)visit(pos-1);if(x<width-1)visit(pos+1);if(y)visit(pos-width);if(y<height-1)visit(pos+width);
    }
    if(tail>=16)regions.push({id,area:tail,x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1});
  }
  regions.sort((a,b)=>b.area-a.area);
  // Glasses/hair can split one face into cheeks, forehead and ears. Group nearby
  // small islands for one pass, but retain their exact original mask pixels.
  const remap=new Uint16Array(id+1),groups:typeof regions=[];
  for(const region of regions){
    const parent=groups.find(g=>region.area<g.area*0.5
      && region.x>=g.x-g.width*0.4 && region.x+region.width<=g.x+g.width*1.4
      && region.y>=g.y-g.height*0.5 && region.y+region.height<=g.y+g.height*1.5);
    if(parent){
      remap[region.id]=parent.id;
      const right=Math.max(parent.x+parent.width,region.x+region.width),bottom=Math.max(parent.y+parent.height,region.y+region.height);
      parent.x=Math.min(parent.x,region.x);parent.y=Math.min(parent.y,region.y);parent.width=right-parent.x;parent.height=bottom-parent.y;parent.area+=region.area;
    }else{remap[region.id]=region.id;groups.push({...region});}
  }
  for(let i=0;i<labels.length;i++)labels[i]=remap[labels[i]];
  return {labels,regions:groups.slice(0,limit),skipped:Math.max(0,groups.length-limit)};
}

export async function regionMask(mask:Pixels, labels:Uint16Array, id:number):Promise<Blob>{
  const canvas=document.createElement('canvas');canvas.width=mask.width;canvas.height=mask.height;
  const context=canvas.getContext('2d')!,pixels=context.createImageData(mask.width,mask.height);
  for(let i=0;i<labels.length;i++){const v=labels[i]===id?mask.data[i*4]:0;pixels.data.set([v,v,v,255],i*4);}
  context.putImageData(pixels,0,0);
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('无法生成细节选区')),'image/png'));
}

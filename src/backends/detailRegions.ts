import type { Pixels } from './inpaintComposite';
import { inpaintReferenceRect, type InpaintRect } from './inpaintReference';

interface Instance { mask: Pixels; bounds: InpaintRect; area: number }
export interface DetailRegion { mask: Pixels; reference: InpaintRect; part: 'face' | 'eyes' }

function instance(mask: Pixels, width: number, height: number, part: 'face' | 'eyes'): Instance | undefined {
  if (mask.width !== width || mask.height !== height || mask.data.length !== width * height * 4) throw new Error('细节选区尺寸不一致');
  let left=width,top=height,right=-1,bottom=-1,area=0;
  const data=new Uint8ClampedArray(mask.data.length);
  for(let i=0;i<width*height;i++) {
    data[i*4+3]=255;
    if(mask.data[i*4]<128)continue;
    const x=i%width,y=Math.floor(i/width);area++;
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    data.fill(255,i*4,i*4+3);
  }
  if(!area)return;
  const bounds={x:left,y:top,width:right-left+1,height:bottom-top+1},ratio=bounds.width/bounds.height;
  const fraction=area/(width*height),density=area/(bounds.width*bounds.height);
  // Geometry rejects clearly implausible masks, but is not an anatomy classifier.
  // Preserve SAM instance identity instead of merging disconnected parts of different people.
  if(part==='face' ? (bounds.width<24 || bounds.height<24 || ratio<0.3 || ratio>2.2 || fraction>0.5 || density<0.18)
    : (bounds.width<6 || bounds.height<3 || ratio<0.3 || ratio>8 || fraction>0.05 || density<0.15))return;
  return {mask:{width,height,data},bounds,area};
}

function overlap(a:Instance,b:Instance):number {
  const w=a.mask.width,left=Math.max(a.bounds.x,b.bounds.x),top=Math.max(a.bounds.y,b.bounds.y);
  const right=Math.min(a.bounds.x+a.bounds.width,b.bounds.x+b.bounds.width),bottom=Math.min(a.bounds.y+a.bounds.height,b.bounds.y+b.bounds.height);
  let count=0;
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(a.mask.data[(y*w+x)*4] && b.mask.data[(y*w+x)*4])count++;
  return count/Math.min(a.area,b.area);
}

function insideBounds(eye:Instance,face:Instance):number {
  const b=face.bounds,pad=Math.min(b.width,b.height)*0.1,w=eye.mask.width;
  let count=0;
  for(let y=eye.bounds.y;y<eye.bounds.y+eye.bounds.height;y++)for(let x=eye.bounds.x;x<eye.bounds.x+eye.bounds.width;x++) {
    if(eye.mask.data[(y*w+x)*4] && x>=b.x-pad && x<b.x+b.width+pad && y>=b.y-pad && y<b.y+b.height+pad)count++;
  }
  return count/eye.area;
}

/** Detect once on the unchanged baseline. Each accepted face gets at most one repaint. */
export function planDetailRegions(faceMasks:Pixels[],eyeMasks:Pixels[],size:{width:number;height:number},options:{face:boolean;eyes:boolean},limit=6) {
  const {width,height}=size;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0||width*height>16_000_000)throw new Error('局部细节图片尺寸无效或超过 1600 万像素');
  let rejected=0;
  const faces:Instance[]=[];
  for(const mask of faceMasks) {
    const face=instance(mask,width,height,'face');
    if(!face){rejected++;continue;}
    if(faces.some(other=>overlap(face,other)>0.85))continue;
    faces.push(face);
  }
  const ambiguous=new Set<Instance>();
  for(let i=0;i<faces.length;i++)for(let j=i+1;j<faces.length;j++)if(overlap(faces[i],faces[j])>0.1){ambiguous.add(faces[i]);ambiguous.add(faces[j]);}
  const accepted=faces.filter(f=>!ambiguous.has(f));rejected+=ambiguous.size;
  const eyes=new Map<Instance,Instance[]>();
  if(options.eyes)for(const mask of eyeMasks) {
    const eye=instance(mask,width,height,'eyes');
    if(!eye){rejected++;continue;}
    const owners=faces.filter(face=>insideBounds(eye,face)>=0.9 && eye.area<face.area*0.35);
    if(owners.length!==1 || ambiguous.has(owners[0])){rejected++;continue;}
    const list=eyes.get(owners[0])??[];
    if(!list.some(other=>overlap(eye,other)>0.85))list.push(eye);
    eyes.set(owners[0],list);
  }
  const regions:DetailRegion[]=[];
  for(const face of accepted) {
    const parts=eyes.get(face)??[];
    if(parts.length>2){rejected+=parts.length;parts.length=0;}
    if(!options.face&&!parts.length)continue;
    const data=options.face?new Uint8ClampedArray(face.mask.data):new Uint8ClampedArray(width*height*4);
    for(let i=0;i<width*height;i++) {
      data[i*4+3]=255;
      if(parts.some(eye=>eye.mask.data[i*4]))data.fill(255,i*4,i*4+3);
    }
    regions.push({mask:{width,height,data},reference:inpaintReferenceRect(face.bounds,width,height,1.6),part:options.face?'face':'eyes'});
  }
  // Expanded reference crops may overlap; editable pixels must not.
  const owner=new Uint8Array(width*height),conflicts=new Set<number>();
  for(let r=0;r<regions.length;r++)for(let i=0;i<owner.length;i++)if(regions[r].mask.data[i*4]) {
    if(owner[i]){conflicts.add(owner[i]-1);conflicts.add(r);}else owner[i]=r+1;
  }
  const safe=regions.filter((_,i)=>!conflicts.has(i));
  rejected+=regions.length-safe.length;
  return {regions:safe.slice(0,limit),rejected,skipped:Math.max(0,safe.length-limit)};
}

export async function detailMaskBlob(mask:Pixels):Promise<Blob> {
  const canvas=document.createElement('canvas');canvas.width=mask.width;canvas.height=mask.height;
  const context=canvas.getContext('2d')!,pixels=context.createImageData(mask.width,mask.height);
  pixels.data.set(mask.data);context.putImageData(pixels,0,0);
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('无法生成细节选区')),'image/png'));
}

/** Never inject full-scene actions or both characters' appearance into a facial crop. */
export function detailPrompt(part:'face'|'eyes') {
  return part==='face'
    ? 'Close-up detail of the existing face. Preserve its identity, facial proportions, head angle, expression and gaze. Preserve existing eyes, hair, accessories, colors, lighting and drawing style. Subtle clean facial detail.'
    : 'Close-up detail of the existing eyes within the same face. Preserve their exact number, position, shape, openness, gaze and iris color. Preserve glasses, expression, lighting and drawing style. Subtle clean eye detail.';
}

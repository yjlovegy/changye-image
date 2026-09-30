import {describe,it,expect} from 'vitest';
import {planDetailRegions} from './detailRegions';
const size={width:256,height:192};
function mask(x:number,y:number,w:number,h:number,value=255){
 const data=new Uint8ClampedArray(size.width*size.height*4);
 for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++)data[(row*size.width+col)*4]=value;
 return {...size,data};
}
const both={face:true,eyes:true},onlyEyes={face:false,eyes:true};
describe('instance-based detail planning',()=>{
 it('preserves separate nearby people and merges facial and eye work into one pass per face',()=>{
  const faces=[mask(20,40,60,90),mask(85,40,60,90)],before=faces.map(f=>f.data.slice());
  const eyes=[mask(30,60,12,7),mask(56,60,12,7),mask(95,60,12,7),mask(121,60,12,7)];
  const plan=planDetailRegions(faces,eyes,size,both);
  expect(plan.regions).toHaveLength(2);expect(plan.rejected).toBe(0);
  expect(plan.regions[0].mask.data[(60*256+100)*4]).toBe(0);
  expect(plan.regions[1].mask.data[(60*256+35)*4]).toBe(0);
  faces.forEach((f,i)=>expect(f.data).toEqual(before[i]));
 });
 it('pairs eyes in the same face context without turning the whole face into the edit mask',()=>{
  const eyes=[mask(30,60,12,7),mask(56,60,12,7)];
  const plan=planDetailRegions([mask(20,40,60,90)],eyes,size,onlyEyes);
  expect(plan.regions).toHaveLength(1);const r=plan.regions[0];
  expect(r.reference.width).toBeGreaterThan(60);expect(r.part).toBe('eyes');
  expect(r.mask.data[(100*256+45)*4]).toBe(0);expect(r.mask.data[(62*256+35)*4]).toBe(255);
 });
 it('keeps a partially occluded instance together without guessing across instances',()=>{
  const face=mask(20,40,60,90);
  for(let y=70;y<80;y++)for(let x=20;x<80;x++)face.data[(y*256+x)*4]=0;
  expect(planDetailRegions([face],[],size,{face:true,eyes:false}).regions).toHaveLength(1);
 });
 it('deduplicates identical detections and skips conflicting face regions',()=>{
  const face=mask(20,40,60,90);
  expect(planDetailRegions([face,face],[],size,both).regions).toHaveLength(1);
  const plan=planDetailRegions([face,mask(50,40,60,90)],[],size,both);
  expect(plan.regions).toHaveLength(0);expect(plan.rejected).toBe(2);
 });
 it('rejects giant, narrow, tiny and weak masks',()=>{
  const plan=planDetailRegions([mask(0,0,256,192),mask(20,10,8,130),mask(20,10,10,10),mask(20,40,60,90,50)],[],size,both);
  expect(plan.regions).toHaveLength(0);expect(plan.rejected).toBe(4);
 });
 it('does not invent eye edits without a reliable face or for orphan eyes',()=>{
  expect(planDetailRegions([], [mask(30,60,12,7)],size,onlyEyes).regions).toHaveLength(0);
  const plan=planDetailRegions([mask(20,40,60,90)],[mask(200,60,12,7)],size,onlyEyes);
  expect(plan.regions).toHaveLength(0);expect(plan.rejected).toBe(1);
 });
 it('accepts one visible eye in a side face and rejects more than two eye instances',()=>{
  const face=mask(20,40,60,90);
  expect(planDetailRegions([face],[mask(30,60,12,7)],size,onlyEyes).regions).toHaveLength(1);
  expect(planDetailRegions([face],[mask(24,60,8,7),mask(40,60,8,7),mask(60,60,8,7)],size,onlyEyes).regions).toHaveLength(0);
 });
 it('rejects mismatched dimensions',()=>{
  expect(()=>planDetailRegions([{...mask(20,40,60,90),width:1}],[],size,both)).toThrow('尺寸');
 });
});

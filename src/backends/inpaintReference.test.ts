import { expect, it } from 'vitest';
import { inpaintReferenceRect, inpaintReferenceSize } from './inpaintReference';
it.each([{x:0,y:0,width:13,height:18},{x:980,y:1890,width:100,height:30},{x:300,y:500,width:200,height:180},{x:0,y:0,width:1080,height:1920}])('contains the complete mask without leaving the source: %j',b=>{
 for(const factor of [1.2,1.5,2,3]){
  const r=inpaintReferenceRect(b,1080,1920,factor);
  expect(r.x).toBeLessThanOrEqual(b.x);expect(r.y).toBeLessThanOrEqual(b.y);
  expect(r.x+r.width).toBeGreaterThanOrEqual(b.x+b.width);expect(r.y+r.height).toBeGreaterThanOrEqual(b.y+b.height);
  expect(r.x+r.width).toBeLessThanOrEqual(1080);expect(r.y+r.height).toBeLessThanOrEqual(1920);
 }
});
it('uses the full source for full reference and keeps portrait proportions on the latent grid',()=>{
 const b={x:450,y:800,width:100,height:80};
 const r=inpaintReferenceRect(b,1080,1920,2,true);
 expect(r).toEqual({x:0,y:0,width:1080,height:1920});
 expect(inpaintReferenceSize(r,1024)).toEqual({width:576,height:1024});
 expect(b).toEqual({x:450,y:800,width:100,height:80});
});

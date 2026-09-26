import { describe, expect, it } from 'vitest';
import { blendProtectedPixels, maskBounds, type Pixels } from './inpaintComposite';
function pixels(width:number,height:number,color:number):Pixels {
  const data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4){data.set([color,color,color,255],i);}
  return {width,height,data};
}
describe('strict inpaint compositing',()=>{
 it.each([0,1,6,32])('preserves every unselected pixel and holes with %s px inward feather',feather=>{
  const source=pixels(23,19,30),generated=pixels(23,19,240),mask=pixels(23,19,0);
  for(let y=3;y<17;y++)for(let x=4;x<19;x++)mask.data[(y*23+x)*4]=255;
  mask.data[(9*23+10)*4]=0;
  source.data[3]=127;
  const before=source.data.slice(),out=blendProtectedPixels(source,generated,mask,feather);
  for(let i=0;i<mask.data.length;i+=4)if(mask.data[i]===0)expect([...out.data.slice(i,i+4)]).toEqual([...source.data.slice(i,i+4)]);
  expect(out.data[(12*23+15)*4]).toBeGreaterThan(30);
  expect(source.data).toEqual(before);
 });
 it('uses new pixels in the center, blends only inside the boundary, and keeps output dimensions',()=>{
  const source=pixels(9,9,0),generated=pixels(9,9,200),mask=pixels(9,9,0);
  for(let y=1;y<8;y++)for(let x=1;x<8;x++)mask.data[(y*9+x)*4]=255;
  const out=blendProtectedPixels(source,generated,mask,2);
  expect(out.data[(4*9+4)*4]).toBe(200);
  expect(out.data[(1*9+4)*4]).toBe(67);
  expect(out.data[(0*9+4)*4]).toBe(0);
  expect([out.width,out.height]).toEqual([9,9]);
  expect(maskBounds(mask)).toEqual({width:7,height:7});
 });
 it('rejects wrong output dimensions and empty selections',()=>{
  expect(()=>blendProtectedPixels(pixels(3,3,0),pixels(2,3,0),pixels(3,3,255),6)).toThrow('尺寸');
  expect(()=>maskBounds(pixels(3,3,0))).toThrow('涂选');
 });
});

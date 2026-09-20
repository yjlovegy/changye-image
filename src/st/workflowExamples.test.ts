import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanUnusedWorkflowExample, normalizeWorkflowExample, removeWorkflowExample, setWorkflowExample, WORKFLOW_EXAMPLE_FOLDER } from './workflowExamples';
import { uploadUserImage, deleteUserImage } from './images';
vi.mock('./images', () => ({ uploadUserImage: vi.fn(), deleteUserImage: vi.fn() }));
vi.mock('./imageFile', () => ({ readFileAsDataUrl: vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=') }));
const oldPath = `/user/images/${WORKFLOW_EXAMPLE_FOLDER}/wfimg_old.png`;
const newPath = `/user/images/${WORKFLOW_EXAMPLE_FOLDER}/wfimg_new.png`;
const file = () => new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'test.png', { type: 'image/png' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
describe('workflow example storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uploadUserImage).mockResolvedValue(newPath);
    vi.mocked(deleteUserImage).mockResolvedValue(true);
    vi.stubGlobal('Image', class { src = ''; decode = async () => {}; });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('accepts only owned image paths, including encoded folder names', () => {
    expect(normalizeWorkflowExample(encodeURI(oldPath))).toBe(oldPath);
    expect(normalizeWorkflowExample(oldPath.slice(1))).toBe(oldPath);
    for (const bad of ['https://evil.example/a.png','//evil.example/a.png','data:image/png;base64,a','/user/images/another/a.png',oldPath.replace('wfimg_old.png','../a.png'),oldPath+'?x=1',oldPath.replace('.png','.svg')]) {
      expect(normalizeWorkflowExample(bad)).toBeUndefined();
    }
  });
  it('stores an original-format file in its dedicated folder, then replaces the reference', async () => {
    const target = { id:'a', exampleImage:oldPath };
    await expect(setWorkflowExample(target,file(),()=>[target])).resolves.toBe(true);
    expect(uploadUserImage).toHaveBeenCalledWith(WORKFLOW_EXAMPLE_FOLDER,expect.stringMatching(/^wfimg_/),'iVBORw0KGgo=','png');
    expect(target.exampleImage).toBe(newPath);
    expect(deleteUserImage).toHaveBeenCalledWith(oldPath);
  });
  it('retains the old image when upload fails and allows retry', async () => {
    const target = { id:'a', exampleImage:oldPath };
    vi.mocked(uploadUserImage).mockRejectedValueOnce(new Error('offline'));
    await expect(setWorkflowExample(target,file(),()=>[target])).rejects.toThrow('offline');
    expect(target.exampleImage).toBe(oldPath);
    expect(deleteUserImage).not.toHaveBeenCalled();
    await setWorkflowExample(target,file(),()=>[target]);
    expect(target.exampleImage).toBe(newPath);
  });
  it('does not delete a shared picture while a workflow copy uses it', async () => {
    const a = { id:'a', exampleImage:oldPath }, b = { id:'b', exampleImage:oldPath };
    await removeWorkflowExample(a,()=>[a,b]);
    expect(a.exampleImage).toBeUndefined();
    expect(b.exampleImage).toBe(oldPath);
    expect(deleteUserImage).not.toHaveBeenCalled();
    await removeWorkflowExample(b,()=>[a,b]);
    expect(deleteUserImage).toHaveBeenCalledExactlyOnceWith(oldPath);
  });
  it('updates the captured target even if the active workflow switches', async () => {
    const a = { id:'a', exampleImage:oldPath }, b = { id:'b', exampleImage:oldPath };
    let owners=[a,b];
    const wait=deferred<string>();
    vi.mocked(uploadUserImage).mockReturnValueOnce(wait.promise);
    const uploading=setWorkflowExample(a,file(),()=>owners);
    await vi.waitFor(()=>expect(uploadUserImage).toHaveBeenCalled());
    owners=[b,a];
    await expect(setWorkflowExample(a,file(),()=>owners)).rejects.toThrow('正在处理');
    wait.resolve(newPath);await uploading;
    expect(a.exampleImage).toBe(newPath);expect(b.exampleImage).toBe(oldPath);
    expect(deleteUserImage).not.toHaveBeenCalled();
  });
  it('discards an in-flight image if its workflow was deleted', async () => {
    const a={id:'a',exampleImage:oldPath};let owners=[a];
    const wait=deferred<string>();vi.mocked(uploadUserImage).mockReturnValueOnce(wait.promise);
    const uploading=setWorkflowExample(a,file(),()=>owners);
    await vi.waitFor(()=>expect(uploadUserImage).toHaveBeenCalled());
    owners=[];wait.resolve(newPath);
    await expect(uploading).rejects.toThrow('目标工作流已删除');
    expect(a.exampleImage).toBe(oldPath);expect(deleteUserImage).toHaveBeenCalledWith(newPath);
  });
  it('reports cleanup failure without rolling back a successful upload', async () => {
    const a={id:'a',exampleImage:oldPath};vi.mocked(deleteUserImage).mockRejectedValue(new Error('offline'));
    await expect(setWorkflowExample(a,file(),()=>[a])).resolves.toBe(false);
    expect(a.exampleImage).toBe(newPath);
  });
  it('rejects unsupported, spoofed and oversized images before uploading', async () => {
    const a={id:'a'};
    for (const invalid of [new File(['svg'],'a.svg',{type:'image/svg+xml'}),new File(['html'],'a.png',{type:'image/png'}),new File([new Uint8Array(20*1024*1024+1)],'a.png',{type:'image/png'})]) {
      await expect(setWorkflowExample(a,invalid,()=>[a])).rejects.toThrow();
    }
    expect(uploadUserImage).not.toHaveBeenCalled();
    await cleanUnusedWorkflowExample('/user/images/another/file.png',()=>[]);
    expect(deleteUserImage).not.toHaveBeenCalled();
  });
});

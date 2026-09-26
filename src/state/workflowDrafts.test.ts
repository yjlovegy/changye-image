import {describe,it,expect} from 'vitest';
import {createWorkflowDrafts} from './workflowDrafts';
import {computed} from 'vue';

describe('workflow checkpoints',()=>{
  const preset=()=>({id:'a',workflow:'original',fixed:{negative:'bad'},auto:{enabled:false},loras:[{name:'one',weight:1}]});
  it('isolates nested edits, supports testing, and restores the last saved configuration',()=>{
    const saved=preset(),store=createWorkflowDrafts<ReturnType<typeof preset>>(),draft=store.edit(saved);
    draft.loras[0].weight=.4;draft.fixed.negative='different';draft.auto.enabled=true;
    expect(saved).toEqual(preset());expect(store.current(saved)).toBe(draft);expect(store.dirty('a')).toBe(true);
    store.discard('a');expect(store.current(saved)).toBe(saved);expect(store.edit(saved)).toEqual(preset());
  });
  it('commits a clone only on explicit save, then establishes a new rollback baseline',()=>{
    let saved=preset();const store=createWorkflowDrafts<typeof saved>();const draft=store.edit(saved);draft.workflow='new';
    const dirty=computed(()=>store.dirty('a'));expect(dirty.value).toBe(true);
    saved=store.commit(saved);expect(saved.workflow).toBe('new');expect(dirty.value).toBe(false);
    draft.workflow='trial';expect(saved.workflow).toBe('new');store.discard('a');expect(store.current(saved).workflow).toBe('new');
  });
  it('isolates workflows and rejects overwriting a changed saved baseline',()=>{
    const a=preset(),b={...preset(),id:'b'},store=createWorkflowDrafts<typeof a>();store.edit(a).workflow='trial';
    expect(store.edit(b).workflow).toBe('original');a.workflow='changed elsewhere';expect(()=>store.commit(a)).toThrow('其他操作');expect(a.workflow).toBe('changed elsewhere');
  });
});

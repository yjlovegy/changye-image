import type { ComfyWorkflow } from './comfyui';

/** Request-local only: neutralize negative conditioning without touching stored text or wiring. */
export function muteWorkflowNegative(workflow: ComfyWorkflow): ComfyWorkflow {
  const result: ComfyWorkflow = JSON.parse(JSON.stringify(workflow));
  for (const [id, node] of Object.entries(workflow)) {
    const inputs = node.inputs as Record<string, unknown> | undefined;
    if (!inputs || !Array.isArray(inputs.negative) || inputs.negative.length !== 2) continue;
    let zeroId = `cy_negative_off_${id}`;
    while (result[zeroId]) zeroId += '_';
    // Prefer positive conditioning so the disabled negative branch need not execute.
    const source = Array.isArray(inputs.positive) ? inputs.positive : inputs.negative;
    result[zeroId] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: [...source] } };
    (result[id].inputs as Record<string, unknown>).negative = [zeroId, 0];
  }
  return result;
}

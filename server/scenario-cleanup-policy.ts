export type ScenarioCleanupDecision =
  | { action: "run" }
  | { action: "skip" }
  | { action: "blocked"; summary: string };

interface ScenarioCleanupState {
  setupAttempted: boolean;
  isDefault: boolean;
  hasCleanupInstructions: boolean;
  recoveryRequired: boolean;
  modelRequestFailed: boolean;
}

export function decideScenarioCleanup(state: ScenarioCleanupState): ScenarioCleanupDecision {
  if (!state.setupAttempted || state.isDefault) return { action: "skip" };
  if (state.modelRequestFailed) {
    return {
      action: "blocked",
      summary: "模型接口异常，无法执行自动清理，环境可能残留配置",
    };
  }
  if (state.hasCleanupInstructions) return { action: "run" };
  if (state.recoveryRequired) {
    return {
      action: "blocked",
      summary: "场景未配置自动清理要求，环境可能残留配置",
    };
  }
  return { action: "skip" };
}

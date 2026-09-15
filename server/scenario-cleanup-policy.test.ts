import assert from "node:assert/strict";
import test from "node:test";
import { decideScenarioCleanup } from "./scenario-cleanup-policy.js";

const baseState = {
  setupAttempted: true,
  isDefault: false,
  hasCleanupInstructions: true,
  recoveryRequired: false,
  modelRequestFailed: false,
};

test("runs cleanup after a non-default scenario setup starts", () => {
  assert.deepEqual(decideScenarioCleanup(baseState), { action: "run" });
  assert.deepEqual(decideScenarioCleanup({ ...baseState, recoveryRequired: true }), { action: "run" });
});

test("does not run cleanup before setup starts or for the default scenario", () => {
  assert.deepEqual(decideScenarioCleanup({ ...baseState, setupAttempted: false }), { action: "skip" });
  assert.deepEqual(decideScenarioCleanup({ ...baseState, isDefault: true }), { action: "skip" });
});

test("reports residual configuration risk when recovery has no cleanup instructions", () => {
  assert.deepEqual(decideScenarioCleanup({
    ...baseState,
    hasCleanupInstructions: false,
    recoveryRequired: true,
  }), {
    action: "blocked",
    summary: "场景未配置自动清理要求，环境可能残留配置",
  });
});

test("does not claim cleanup when the model interface is unavailable", () => {
  assert.deepEqual(decideScenarioCleanup({ ...baseState, modelRequestFailed: true }), {
    action: "blocked",
    summary: "模型接口异常，无法执行自动清理，环境可能残留配置",
  });
});

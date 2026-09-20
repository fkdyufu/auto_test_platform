import assert from "node:assert/strict";
import test from "node:test";
import { flattenExecutionGroups, groupCasesByExecutionOrder, moveCaseWithinScenario, moveScenarioGroup, toggleOrderedCase } from "./test-order-sequence";

const cases = [
  { id: "a1", scenarioId: "a" },
  { id: "a2", scenarioId: "a" },
  { id: "b1", scenarioId: "b" },
  { id: "b2", scenarioId: "b" },
];

test("normalizes an interleaved list into its actual grouped execution order", () => {
  const groups = groupCasesByExecutionOrder(["a1", "b1", "a2", "b2"], cases);
  assert.deepEqual(groups.map((group) => group.scenarioId), ["a", "b"]);
  assert.deepEqual(flattenExecutionGroups(groups), ["a1", "a2", "b1", "b2"]);
});

test("moves scenario groups and cases without crossing scenario boundaries", () => {
  assert.deepEqual(moveScenarioGroup(["a1", "a2", "b1", "b2"], cases, "b", -1), ["b1", "b2", "a1", "a2"]);
  assert.deepEqual(moveCaseWithinScenario(["a1", "a2", "b1", "b2"], cases, "a2", -1), ["a2", "a1", "b1", "b2"]);
  assert.deepEqual(moveCaseWithinScenario(["a1", "a2", "b1", "b2"], cases, "a1", -1), ["a1", "a2", "b1", "b2"]);
});

test("adds a case to the end of its scenario group and removes selected cases", () => {
  assert.deepEqual(toggleOrderedCase(["a1", "b1"], cases, "a2"), ["a1", "a2", "b1"]);
  assert.deepEqual(toggleOrderedCase(["a1", "a2", "b1"], cases, "a1"), ["a2", "b1"]);
});

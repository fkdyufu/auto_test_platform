import assert from "node:assert/strict";
import test from "node:test";
import { formatStepRows, parseStepRows, stepRowsFromLegacy, stepRowsToText } from "../shared/test-case-steps";

test("splits matching numbered legacy steps while retaining multiline cell content", () => {
  assert.deepEqual(stepRowsFromLegacy("1. 登录\n输入账号\n2. 打开状态页", "1. 登录成功\n2. 状态正常\n版本可见"), [
    { step: "登录\n输入账号", expected: "登录成功" },
    { step: "打开状态页", expected: "状态正常\n版本可见" },
  ]);
});

test("keeps uncertain legacy text intact instead of inventing pairings", () => {
  for (const [steps, expected] of [
    ["登录\n查看状态", "成功\n正常"],
    ["1. 登录\n2. 查看状态", "最终页面正确"],
    ["1. 登录\n3. 查看状态", "1. 成功\n2. 正常"],
    ["1. 登录\n2. 查看状态", "1. 成功\n2. 正常\n3. 其他结果"],
  ]) assert.deepEqual(stepRowsFromLegacy(steps, expected), [{ step: steps, expected }]);
});

test("formats row pairs in execution order without skipping blank expectations", () => {
  const rows = [{ step: "准备接口", expected: "" }, { step: "发送流量\n读取计数", expected: "计数增加" }];
  assert.deepEqual(stepRowsToText(rows), { steps: "1. 准备接口\n2. 发送流量\n读取计数", expectedResult: "1. \n2. 计数增加" });
  assert.match(formatStepRows(rows), /步骤 1：\n准备接口\n对应预期：\n本步骤未指定单独预期/);
  assert.match(formatStepRows(rows), /步骤 2：\n发送流量\n读取计数\n对应预期：\n计数增加/);
  assert.deepEqual(parseStepRows(rows), rows);
  assert.throws(() => parseStepRows([{ step: "操作", expected: 1 }]));
  assert.throws(() => parseStepRows([]));
});

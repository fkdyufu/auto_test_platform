import assert from "node:assert/strict";
import test from "node:test";
import { FinishFormatError, MAX_FORMAT_REJECTIONS, resolveFinishSubmission, type FinishSubmission } from "./finish-result.js";

const caseRules = { stepCount: 3 };
const validFailure: FinishSubmission = {
  status: "failed",
  headline: "非法掩码不报错，还留下无掩码的半配置",
  failureType: "product_defect",
  checks: [
    { step: 2, result: "failed", actual: " 暂存区出现无 netmask 的配置 " },
    { step: 1, result: "passed", actual: "地址、网关均有提示" },
    { step: 3, result: "passed", actual: "保存成功" },
  ],
  evidence: ["validationErrors 为 []", "  "],
  notes: "推测：netmask 未设置 datatype",
  log: "完整过程",
};

test("accepts a structured case conclusion and normalizes it", () => {
  assert.deepEqual(resolveFinishSubmission(validFailure, caseRules, 0), {
    status: "failed",
    summary: "非法掩码不报错，还留下无掩码的半配置",
    failureType: "product_defect",
    checks: [
      { step: 1, result: "passed", actual: "地址、网关均有提示" },
      { step: 2, result: "failed", actual: "暂存区出现无 netmask 的配置" },
      { step: 3, result: "passed", actual: "保存成功" },
    ],
    evidenceList: ["validationErrors 为 []"],
    notes: "推测：netmask 未设置 datatype",
    log: "完整过程",
  });
});

test("rejects long headlines, mismatched checks and missing failure types with actionable messages", () => {
  const submission: FinishSubmission = {
    status: "failed",
    headline: "前".repeat(61),
    checks: [{ step: 1, result: "passed", actual: "正常" }, { step: 1, result: "passed", actual: "正常" }, { step: 4, result: "passed", actual: "" }],
  };
  assert.throws(() => resolveFinishSubmission(submission, caseRules, 0), (error: Error) => {
    assert.ok(error instanceof FinishFormatError);
    assert.match(error.message, /headline 有 61 字，超过 60 字上限/);
    assert.match(error.message, /failureType/);
    assert.match(error.message, /step 须恰好为 1 到 3 各一次/);
    assert.match(error.message, /步骤 4 的 actual 不能为空/);
    assert.match(error.message, /至少要有一个步骤为 failed 或 not_run/);
    return true;
  });
  assert.throws(() => resolveFinishSubmission({ ...validFailure, checks: validFailure.checks!.slice(0, 2) }, caseRules, 0), /须与用例的 3 个步骤一一对应，当前提交了 2 条/);
  assert.throws(() => resolveFinishSubmission({ ...validFailure, headline: "第一句\n第二句" }, caseRules, 0), /不能换行/);
});

test("passed conclusions require every step to pass and drop failure types", () => {
  assert.throws(() => resolveFinishSubmission({ ...validFailure, status: "passed" }, caseRules, 0), /所有步骤都必须为 passed/);
  const passed = resolveFinishSubmission({
    ...validFailure,
    status: "passed",
    checks: validFailure.checks!.map((check) => ({ ...check, result: "passed" as const })),
  }, caseRules, 0);
  assert.equal(passed.failureType, undefined);
});

test("precondition failures may mark every step as not run", () => {
  const result = resolveFinishSubmission({
    status: "failed",
    headline: "前置准备失败：H1 无法获得地址",
    failureType: "environment",
    checks: [1, 2, 3].map((step) => ({ step, result: "not_run" as const, actual: "前置条件未满足，未执行" })),
  }, caseRules, 0);
  assert.equal(result.checks?.every((check) => check.result === "not_run"), true);
});

test("setup and cleanup conclusions only need a headline", () => {
  assert.deepEqual(resolveFinishSubmission({ status: "failed", headline: "交换机端口 9 无法开启", checks: [{ step: 1, result: "failed", actual: "x" }] }, {}, 0), {
    status: "failed",
    summary: "交换机端口 9 无法开启",
  });
  assert.throws(() => resolveFinishSubmission({ status: "passed", headline: "场".repeat(80) }, {}, 0), /超过 60 字上限/);
});

test("after repeated rejections the submission is kept rather than losing the result", () => {
  const longHeadline = `${"执行过程很长。".repeat(12)}结论失败`;
  assert.throws(() => resolveFinishSubmission({ status: "failed", headline: longHeadline }, caseRules, MAX_FORMAT_REJECTIONS - 1), FinishFormatError);
  const result = resolveFinishSubmission({ status: "failed", headline: longHeadline, log: "原始记录" }, caseRules, MAX_FORMAT_REJECTIONS);
  assert.equal([...result.summary].length, 60);
  assert.match(result.summary, /…$/);
  assert.equal(result.log, `${longHeadline}\n\n原始记录`);
  assert.equal(result.checks, undefined);
});

test("unescapes literal line breaks in logs that contain no real ones", () => {
  const result = resolveFinishSubmission({ status: "passed", headline: "场景搭建完成", log: "步骤1：登录\\n步骤2：配置", notes: "第一行\n含 printf 'a\\nb'" }, {}, 0);
  assert.equal(result.log, "步骤1：登录\n步骤2：配置");
  assert.equal(result.notes, "第一行\n含 printf 'a\\nb'");
});

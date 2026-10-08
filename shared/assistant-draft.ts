import type { AssetKind } from "./assistant.js";
import { parseStepRows, stepRowsFromLegacy, stepRowsToText } from "./test-case-steps.js";

const textFields: Record<AssetKind, string[]> = {
  case: ["name", "scenarioId", "precondition", "steps", "expectedResult"],
  device: ["name", "model", "description"],
  scenario: ["name", "category", "description", "setupInstructions", "verificationInstructions", "cleanupInstructions"],
  order: ["name", "description"],
};

export function applyDraftPatch(kind: AssetKind, draft: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(draft);
  for (const [field, value] of Object.entries(values)) {
    if (textFields[kind].includes(field)) {
      if (typeof value !== "string") throw new Error(`字段 ${field} 必须是文本`);
      next[field] = value;
    } else if (field === "stepRows" && kind === "case") {
      next.stepRows = parseStepRows(value);
    } else if ((field === "caseIds" && ["scenario", "order"].includes(kind)) || (field === "types" && kind === "device")) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`字段 ${field} 必须是文本数组`);
      next[field] = [...value];
    } else if ((field === "roles" || field === "parameters") && kind === "scenario" || field === "controlInterfaces" && kind === "device") {
      if (!Array.isArray(value) || value.length > 100) throw new Error(`字段 ${field} 必须是数组且不超过 100 项`);
      const previous = Array.isArray(draft[field]) ? draft[field] as Record<string, unknown>[] : [];
      const required = field === "roles" ? ["key", "deviceId"] : field === "parameters" ? ["key", "name", "defaultValue"] : ["name", "type", "address", "username"];
      next[field] = value.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`字段 ${field} 中的项目格式不正确`);
        const input = item as Record<string, unknown>;
        const allowed = [...required, "id", ...(field === "controlInterfaces" ? ["password", "hasPassword"] : [])];
        if (Object.keys(input).some((key) => !allowed.includes(key)) || required.some((key) => typeof input[key] !== "string") || input.id !== undefined && typeof input.id !== "string") throw new Error(`字段 ${field} 中的项目缺少字段或类型不正确`);
        if (field === "controlInterfaces" && (!["web", "ssh", "telnet", "serial", "api", "other"].includes(String(input.type)) || input.password !== undefined && typeof input.password !== "string")) throw new Error("控制接口格式不正确");
        const id = typeof input.id === "string" && input.id ? input.id : `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const old = previous.find((control) => control.id === id);
        return { ...input, id, ...(field === "controlInterfaces" ? { password: input.password ?? old?.password ?? "" } : {}) };
      });
    } else throw new Error(`不可修改字段 ${field}`);
  }
  if (kind === "case") {
    if (values.stepRows !== undefined) Object.assign(next, stepRowsToText(parseStepRows(next.stepRows)));
    else if (Object.hasOwn(values, "steps") || Object.hasOwn(values, "expectedResult")) {
      next.stepRows = stepRowsFromLegacy(typeof next.steps === "string" ? next.steps : "", typeof next.expectedResult === "string" ? next.expectedResult : "");
    }
  }
  return next;
}

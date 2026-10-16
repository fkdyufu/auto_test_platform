import type { AssetKind } from "./assistant.js";
import { parseStepRows, stepRowsFromLegacy, stepRowsToText } from "./test-case-steps.js";
import { CONTROL_KINDS, isControlKind, secretKeys } from "./control-interfaces.js";
import { isDeviceTemplateId } from "./device-templates.js";

const textFields: Record<AssetKind, string[]> = {
  case: ["name", "scenarioId", "precondition", "steps", "expectedResult"],
  device: ["name", "description"],
  scenario: ["name", "category", "description", "setupInstructions", "verificationInstructions", "cleanupInstructions"],
  order: ["name", "description"],
};

/** Interfaces proposed for an open device form. Secrets the form already holds are kept when the proposal omits them. */
function draftControlInterfaces(value: unknown, previous: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error("字段 controlInterfaces 必须是数组且不超过 30 项");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("控制接口格式不正确");
    const input = item as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["id", "name", "kind", "settings", "secretsSet"].includes(key))) throw new Error("控制接口包含未知字段");
    if (!isControlKind(input.kind)) throw new Error("控制方式不正确");
    if (input.id !== undefined && typeof input.id !== "string" || input.name !== undefined && typeof input.name !== "string") throw new Error("控制接口格式不正确");
    const settings = input.settings === undefined ? {} : input.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings) || Object.values(settings).some((entry) => typeof entry !== "string")) throw new Error("控制接口 settings 必须是文本字段");
    const known = new Set(CONTROL_KINDS[input.kind].fields.map((field) => field.key));
    if (Object.keys(settings).some((key) => !known.has(key))) throw new Error(`控制接口包含 ${CONTROL_KINDS[input.kind].label} 不支持的字段`);
    const id = typeof input.id === "string" && input.id ? input.id : `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const old = previous.find((control) => control.id === id && control.kind === input.kind);
    const oldSettings = old?.settings && typeof old.settings === "object" ? old.settings as Record<string, string> : {};
    const kept = Object.fromEntries(secretKeys(input.kind).filter((key) => !(settings as Record<string, string>)[key] && oldSettings[key]).map((key) => [key, oldSettings[key]]));
    return {
      id,
      name: typeof input.name === "string" ? input.name : "",
      kind: input.kind,
      settings: { ...settings as Record<string, string>, ...kept },
      secretsSet: Array.isArray(old?.secretsSet) ? old.secretsSet : [],
    };
  });
}

export function applyDraftPatch(kind: AssetKind, draft: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(draft);
  for (const [field, value] of Object.entries(values)) {
    if (textFields[kind].includes(field)) {
      if (typeof value !== "string") throw new Error(`字段 ${field} 必须是文本`);
      next[field] = value;
    } else if (field === "stepRows" && kind === "case") {
      next.stepRows = parseStepRows(value);
    } else if (field === "template" && kind === "device") {
      if (!isDeviceTemplateId(value)) throw new Error("设备类型不正确");
      next.template = value;
    } else if (field === "controlInterfaces" && kind === "device") {
      next.controlInterfaces = draftControlInterfaces(value, Array.isArray(draft.controlInterfaces) ? draft.controlInterfaces as Record<string, unknown>[] : []);
    } else if (field === "caseIds" && ["scenario", "order"].includes(kind)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`字段 ${field} 必须是文本数组`);
      next[field] = [...value];
    } else if ((field === "roles" || field === "parameters") && kind === "scenario") {
      if (!Array.isArray(value) || value.length > 100) throw new Error(`字段 ${field} 必须是数组且不超过 100 项`);
      const required = field === "roles" ? ["key", "deviceId"] : ["key", "name", "defaultValue"];
      next[field] = value.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`字段 ${field} 中的项目格式不正确`);
        const input = item as Record<string, unknown>;
        const allowed = [...required, "id"];
        if (Object.keys(input).some((key) => !allowed.includes(key)) || required.some((key) => typeof input[key] !== "string") || input.id !== undefined && typeof input.id !== "string") throw new Error(`字段 ${field} 中的项目缺少字段或类型不正确`);
        const id = typeof input.id === "string" && input.id ? input.id : `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return { ...input, id };
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

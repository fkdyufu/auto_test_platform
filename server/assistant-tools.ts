import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CatalogError, type CatalogStore } from "./catalog-store.js";
import type { AssistantStore } from "./assistant-store.js";
import type { AssetChange, AssetKind, AssistantPageContext, LabOperation } from "../shared/assistant.js";
import { applyDraftPatch } from "../shared/assistant-draft.js";
import { CONTROL_KINDS, isControlKind, secretKeys, type ControlKind } from "../shared/control-interfaces.js";
import { DEVICE_TEMPLATES } from "../shared/device-templates.js";
import { LAB_LINK_ROLES, LAB_PORT_KINDS } from "../shared/physical-lab.js";
import { MAX_LAB_OPERATIONS, describeLabForAssistant } from "./lab-changes.js";

const controlSettingsDoc = (Object.entries(CONTROL_KINDS) as [ControlKind, typeof CONTROL_KINDS[ControlKind]][])
  .map(([kind, definition]) => `${kind}：${definition.fields.map((field) => `${field.key}（${field.label}${field.options ? `，可选 ${field.options.map((option) => option.value).join("/")}` : ""}${field.required ? "，必填" : ""}）`).join("、")}`)
  .join("；");

export const ASSET_FIELDS: Record<AssetKind, Record<string, string>> = {
  case: { name: "用例名称，必填", scenarioId: "场景 ID，留空使用默认场景", precondition: "前置条件，可选", stepRows: "有序用例步骤数组（1 至 100 行），每项包含 step（步骤文本）和 expected（对应预期文本）；修改完整替换数组，每行步骤必填，用例至少有一个预期。优先使用此字段编辑步骤", steps: "旧接口兼容的步骤文本；编辑步骤优先使用 stepRows", expectedResult: "旧接口兼容的预期文本；编辑预期优先使用 stepRows" },
  device: {
    name: "设备名称，必填且唯一",
    template: `设备类型：${DEVICE_TEMPLATES.map((template) => `${template.id}（${template.name}）`).join("、")}`,
    description: "说明，会提供给执行测试的 AI，可写厂商型号和注意事项",
    controlInterfaces: `接口数组，每项：id（已有接口须保留）、name（可留空）、kind（控制方式）、settings（该方式的字段）。各方式字段：${controlSettingsDoc}。密码和 token 省略或留空时保留已有值`,
  },
  scenario: { name: "场景名称，必填且唯一；默认场景不能改名", category: "功能分类，非默认场景必填", description: "场景说明", roles: "角色数组：id、key、deviceId；非默认场景至少一项，设备须属于当前产品且不能重复绑定", parameters: "参数数组：id、key、name、defaultValue", setupInstructions: "场景搭建要求，非默认场景必填", verificationInstructions: "场景验证要求，非默认场景必填", cleanupInstructions: "场景清理要求", caseIds: "关联用例 ID 数组（仅修改支持）；完整替换场景关联，移出的用例回到默认场景" },
  order: { name: "测试单名称，必填", description: "描述", caseIds: "有序用例 ID 数组，至少一项，须属于当前产品；完整替换关联。执行时按首次出现的场景分组，场景顺序及组内用例顺序均由此数组决定" },
};
const kindSchema = Type.Union([Type.Literal("device"), Type.Literal("scenario"), Type.Literal("case"), Type.Literal("order")]);
const valuesSchema = Type.Record(Type.String(), Type.Unknown());
const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const portRefSchema = Type.Object({ node: Type.String({ description: "节点名称" }), port: Type.String({ description: "端口名" }) });
const LAB_OPERATIONS_DOC = [
  "add_ports：node、ports（如 \"1-24, console\"，已有的跳过）、kind（默认 ethernet）、note",
  "remove_ports：node、ports，端口上的接线一并删除",
  "update_port：node、port，以及要改的 name、kind、note",
  "connect：a、b（各含 node 和 port）、role（默认按端口类型：串口和 USB 为 control，电源为 power，其他为 data）、note；两端须未接线",
  "disconnect：node、port（连线任一端）",
  "update_link：node、port（连线任一端），以及要改的 role、note",
  "set_control_port：node（设备）、controlInterfaceId、port（平台经此端口访问该接口；留空取消指定）",
  "set_rules：rules（完整替换环境规则）",
  "add_node：name（外部节点，如办公网）",
  "rename_node：node、name（平台节点或外部节点）",
  "remove_node：node（仅外部节点，接线一并删除）",
].join("；");
const labOperationSchema = Type.Object({
  op: literals(["add_ports", "remove_ports", "update_port", "connect", "disconnect", "update_link", "set_control_port", "set_rules", "add_node", "rename_node", "remove_node"] as const),
  node: Type.Optional(Type.String()),
  port: Type.Optional(Type.String()),
  ports: Type.Optional(Type.String()),
  kind: Type.Optional(literals(LAB_PORT_KINDS)),
  name: Type.Optional(Type.String()),
  a: Type.Optional(portRefSchema),
  b: Type.Optional(portRefSchema),
  role: Type.Optional(literals(LAB_LINK_ROLES)),
  note: Type.Optional(Type.String()),
  controlInterfaceId: Type.Optional(Type.String()),
  rules: Type.Optional(Type.String()),
});
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

export function normalizeAssistantContext(value: unknown): AssistantPageContext {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const context: AssistantPageContext = { page: String(input.page || "products").slice(0, 80), title: String(input.title || "当前产品").slice(0, 200) };
  if (typeof input.assetKind === "string" && Object.hasOwn(ASSET_FIELDS, input.assetKind)) context.assetKind = input.assetKind as AssetKind;
  if (typeof input.assetId === "string") context.assetId = input.assetId.slice(0, 100);
  if (typeof input.draftToken === "string") context.draftToken = input.draftToken.slice(0, 100);
  if (context.assetKind && input.draft && typeof input.draft === "object" && !Array.isArray(input.draft)) {
    const draft = input.draft as Record<string, unknown>;
    if (Object.keys(draft).some((key) => !Object.hasOwn(ASSET_FIELDS[context.assetKind!], key))) throw new CatalogError("草稿包含未知字段");
    if (JSON.stringify(draft).length > 150_000) throw new CatalogError("当前草稿过大");
    context.draft = structuredClone(draft);
    if (Array.isArray(context.draft.controlInterfaces)) context.draft.controlInterfaces = context.draft.controlInterfaces.map((control) => {
      const item = control && typeof control === "object" ? control as Record<string, unknown> : {};
      const settings = item.settings && typeof item.settings === "object" ? item.settings as Record<string, unknown> : {};
      const secrets = isControlKind(item.kind) ? secretKeys(item.kind) : ["password", "token"];
      const { password: _password, token: _token, ...rest } = item;
      return { ...rest, settings: Object.fromEntries(Object.entries(settings).filter(([key]) => !secrets.includes(key))) };
    });
  }
  return context;
}

export class AssistantAssetReader {
  constructor(private readonly catalog: CatalogStore, private readonly productId: string) {}
  async list(kind: AssetKind) {
    switch (kind) {
      case "case": return this.catalog.listTestCases(this.productId);
      case "device": return this.catalog.listDeviceResources(this.productId);
      case "scenario": return this.catalog.listTestScenarios(this.productId);
      case "order": return this.catalog.listTestOrders(this.productId);
      default: throw new CatalogError("资产类型不正确");
    }
  }
  async get(kind: AssetKind, id: string) {
    const asset = (await this.list(kind)).find((item) => item.id === id);
    if (!asset) throw new CatalogError("资产不存在或不属于当前产品", 404);
    return kind === "scenario" ? { ...asset, caseIds: (await this.catalog.listTestCases(this.productId)).filter((item) => item.scenarioId === id).map((item) => item.id) } : asset;
  }
  async query(kind: AssetKind, options: { query?: string; scenarioId?: string; orderId?: string; deviceId?: string; offset?: number; limit?: number }) {
    let assets: Awaited<ReturnType<AssistantAssetReader["list"]>>[number][] = await this.list(kind);
    if (options.scenarioId) {
      await this.get("scenario", options.scenarioId);
      if (kind !== "case") throw new CatalogError("scenarioId 筛选仅适用于用例");
      assets = assets.filter((item) => "scenarioId" in item && item.scenarioId === options.scenarioId);
    }
    if (options.orderId) {
      const order = await this.catalog.getTestOrder(this.productId, options.orderId);
      if (kind !== "case") throw new CatalogError("orderId 筛选仅适用于用例");
      assets = assets.filter((item) => order.caseIds.includes(item.id));
    }
    if (options.deviceId) {
      await this.get("device", options.deviceId);
      if (kind !== "scenario") throw new CatalogError("deviceId 筛选仅适用于场景");
      assets = assets.filter((item) => "roles" in item && item.roles.some((role) => role.deviceId === options.deviceId));
    }
    if (options.query?.trim()) {
      const query = options.query.trim().toLowerCase();
      assets = assets.filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(query));
    }
    const offset = Math.max(0, Math.trunc(options.offset || 0));
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit || 50)));
    return { total: assets.length, offset, limit, items: assets.slice(offset, offset + limit).map((item) => ({ id: item.id, name: item.name, updatedAt: item.updatedAt, ...("scenarioId" in item ? { scenarioId: item.scenarioId } : {}) })) };
  }
}

export function createAssistantTools(options: { catalog: CatalogStore; store: AssistantStore; productId: string; conversationId: string; runId: string; context: AssistantPageContext; isCancelled: () => boolean }) {
  const reader = new AssistantAssetReader(options.catalog, options.productId);
  const ensureActive = (signal?: AbortSignal) => {
    if (signal?.aborted || options.isCancelled()) throw new CatalogError("助手任务已取消", 409);
  };
  return [
    defineTool({ name: "platform_context", label: "读取页面上下文", description: "读取当前产品、页面、资产和尚未保存的草稿，以及各资产可修改字段。", parameters: Type.Object({}), execute: async () => result({ product: await options.catalog.getProduct(options.productId), context: options.context, fields: ASSET_FIELDS }) }),
    defineTool({ name: "platform_query", label: "查询资产", description: "查询当前产品资产，按名称/ID 或关联关系筛选；返回概要和总数，内容使用 platform_get 读取。须遍历分页才能处理所有匹配项。", parameters: Type.Object({ kind: kindSchema, query: Type.Optional(Type.String()), scenarioId: Type.Optional(Type.String()), orderId: Type.Optional(Type.String()), deviceId: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), execute: async (_id, params) => result(await reader.query(params.kind, params)) }),
    defineTool({ name: "platform_get", label: "读取资产详情", description: "读取当前产品指定资产详情。设备密码不会返回。场景详情包含关联用例 ID。", parameters: Type.Object({ kind: kindSchema, id: Type.String() }), execute: async (_id, params) => result(await reader.get(params.kind, params.id)) }),
    defineTool({ name: "platform_propose_changes", label: "提交资产变更预览", description: "提出通用新增/部分修改/删除操作，不直接保存。服务端校验所有操作并预览关联影响，用户确认后原子提交。每次最多 200 项，update 只传需要改变的字段，数组完整替换。没有用户确认不能声称已保存。", parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 1000 }), changes: Type.Array(Type.Object({ kind: kindSchema, operation: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]), id: Type.Optional(Type.String()), values: Type.Optional(valuesSchema) }), { minItems: 1, maxItems: 200 }) }), execute: async (_id, params, signal) => {
      ensureActive(signal);
      const preview = await options.catalog.previewAssetChanges(options.productId, params.changes as AssetChange[]);
      ensureActive(signal);
      const proposal = await options.store.propose(options.productId, options.conversationId, { runId: options.runId, summary: params.summary, target: "assets", preview });
      return result({ proposalId: proposal.id, status: "pending", affectedAssets: preview.differences.length, message: "变更已校验，等待用户在界面确认；尚未保存" });
    } }),
    defineTool({ name: "platform_propose_draft", label: "提交表单修改预览", description: "为当前打开的编辑表单提出部分字段修改，用户确认后填入表单，不自动保存。只支持当前资产类型的可编辑字段。", parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 1000 }), values: valuesSchema }), execute: async (_id, params, signal) => {
      ensureActive(signal);
      const { context } = options;
      if (!context.assetKind || !context.draft || !context.draftToken) throw new CatalogError("当前没有可编辑表单");
      if (!Object.keys(params.values).length || Object.keys(params.values).some((key) => !Object.hasOwn(ASSET_FIELDS[context.assetKind!], key))) throw new CatalogError("草稿修改字段不正确");
      if (JSON.stringify(params.values).length > 150_000) throw new CatalogError("草稿修改过大");
      applyDraftPatch(context.assetKind, context.draft, params.values);
      const proposal = await options.store.propose(options.productId, options.conversationId, { runId: options.runId, summary: params.summary, target: "draft", context, values: params.values });
      return result({ proposalId: proposal.id, status: "pending", message: "等待用户应用到当前表单，尚未保存" });
    } }),
    defineTool({ name: "platform_lab", label: "读取物理环境", description: "读取当前产品物理环境：环境规则、检查发现的问题（issues）、各节点（设备、平台服务器、外部节点）的端口及每个端口所接的对端（to）和用途（role：data 业务、control 控制、power 供电）、设备控制接口所经端口。node 可只读取一个节点。", parameters: Type.Object({ node: Type.Optional(Type.String({ description: "节点名称或 ID" })) }), execute: async (_id, params) => {
      const [lab, devices] = await Promise.all([options.catalog.getPhysicalLab(options.productId), options.catalog.listDeviceResources(options.productId)]);
      return result(describeLabForAssistant(lab, devices, params.node));
    } }),
    defineTool({ name: "platform_propose_lab", label: "提交接线变更预览", description: `提出物理环境修改，不直接保存。操作按顺序执行，节点和端口用 platform_lab 返回的名称。服务端校验后生成逐条变更预览，用户确认后保存。每次最多 ${MAX_LAB_OPERATIONS} 项。没有用户确认不能声称已保存。各操作字段：${LAB_OPERATIONS_DOC}。`, parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 1000 }), operations: Type.Array(labOperationSchema, { minItems: 1, maxItems: MAX_LAB_OPERATIONS }) }), execute: async (_id, params, signal) => {
      ensureActive(signal);
      const labPreview = await options.catalog.previewPhysicalLabChanges(options.productId, params.operations as LabOperation[]);
      ensureActive(signal);
      const proposal = await options.store.propose(options.productId, options.conversationId, { runId: options.runId, summary: params.summary, target: "lab", labPreview });
      return result({ proposalId: proposal.id, status: "pending", changes: labPreview.changes.map((change) => change.before === undefined || `${change.before}${change.after}`.length > 300 ? change.text : `${change.text}：${change.before} → ${change.after}`), message: "接线变更已校验，等待用户在界面确认；尚未保存" });
    } }),
  ];
}

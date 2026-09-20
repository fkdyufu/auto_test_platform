import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CatalogError, type CatalogStore } from "./catalog-store.js";
import type { AssistantStore } from "./assistant-store.js";
import type { AssetChange, AssetKind, AssistantPageContext } from "../shared/assistant.js";
import { applyDraftPatch } from "../shared/assistant-draft.js";

export const ASSET_FIELDS: Record<AssetKind, Record<string, string>> = {
  case: { name: "用例名称，必填", scenarioId: "场景 ID，留空使用默认场景", precondition: "前置条件，可选", steps: "测试步骤，必填", expectedResult: "预期结果，必填" },
  device: { name: "设备名称，必填且唯一", types: "设备类型字符串数组，至少一项", model: "型号", description: "描述", controlInterfaces: "接口数组：id（已有接口须保留）、name、type（web/ssh/telnet/serial/api/other）、address、username、password（省略保留已有密码）" },
  scenario: { name: "场景名称，必填且唯一；默认场景不能改名", category: "功能分类，非默认场景必填", description: "场景说明", roles: "角色数组：id、key、deviceId；非默认场景至少一项，设备须属于当前产品且不能重复绑定", parameters: "参数数组：id、key、name、defaultValue", setupInstructions: "场景搭建要求，非默认场景必填", verificationInstructions: "场景验证要求，非默认场景必填", cleanupInstructions: "场景清理要求", caseIds: "关联用例 ID 数组（仅修改支持）；完整替换场景关联，移出的用例回到默认场景" },
  order: { name: "测试单名称，必填", description: "描述", caseIds: "有序用例 ID 数组，至少一项，须属于当前产品；完整替换关联。执行时按首次出现的场景分组，场景顺序及组内用例顺序均由此数组决定" },
};
const kindSchema = Type.Union([Type.Literal("device"), Type.Literal("scenario"), Type.Literal("case"), Type.Literal("order")]);
const valuesSchema = Type.Record(Type.String(), Type.Unknown());
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
      const { password: _password, ...rest } = control as Record<string, unknown>;
      return rest;
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
  ];
}

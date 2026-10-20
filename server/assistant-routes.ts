import { Router } from "express";
import { CatalogError, type CatalogStore } from "./catalog-store.js";
import type { AssistantStore } from "./assistant-store.js";
import { normalizeAssistantContext } from "./assistant-tools.js";
import type { AssistantConversation, AssistantPageContext } from "../shared/assistant.js";

export function createAssistantRouter(options: {
  catalog: CatalogStore;
  store: AssistantStore;
  startTurn: (productId: string, id: string, content: string, context: AssistantPageContext) => Promise<{ conversation: AssistantConversation; run: unknown }>;
}) {
  const router = Router();
  const base = "/products/:productId/assistant";
  router.use(`${base}/{*path}`, async (request, _response, next) => {
    try { await options.catalog.getProduct(request.params.productId); next(); } catch (error) { next(error); }
  });
  router.get(`${base}/conversations`, async (request, response, next) => {
    try { response.json(await options.store.list(request.params.productId)); } catch (error) { next(error); }
  });
  router.post(`${base}/conversations`, async (request, response, next) => {
    try { response.status(201).json(await options.store.create(request.params.productId)); } catch (error) { next(error); }
  });
  router.get(`${base}/conversations/:id`, async (request, response, next) => {
    try { response.json(await options.store.get(request.params.productId, request.params.id)); } catch (error) { next(error); }
  });
  router.post(`${base}/conversations/:id/messages`, async (request, response, next) => {
    try {
      const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
      if (!content || content.length > 8_000) throw new CatalogError("消息须包含 1 至 8000 个字符");
      response.status(202).json(await options.startTurn(request.params.productId, request.params.id, content, normalizeAssistantContext(request.body.context)));
    } catch (error) { next(error); }
  });
  router.post(`${base}/conversations/:id/proposals/:proposalId`, async (request, response, next) => {
    try {
      const decision = request.body?.decision;
      if (decision !== "apply" && decision !== "reject") throw new CatalogError("请选择应用或拒绝");
      response.json(await options.store.resolveProposal(request.params.productId, request.params.id, request.params.proposalId, decision, async (proposal) => {
        if (proposal.target === "assets" && proposal.preview) {
          proposal.preview.differences = await options.catalog.applyAssetChanges(request.params.productId, proposal.preview);
        } else if (proposal.target === "lab" && proposal.labPreview) {
          proposal.labPreview.changes = await options.catalog.applyPhysicalLabChanges(request.params.productId, proposal.labPreview);
        } else if (proposal.target === "draft") {
          if (!request.body?.draftToken || request.body.draftToken !== proposal.context?.draftToken) throw new CatalogError("编辑表单已变化，请重新生成草稿修改", 409);
        } else throw new CatalogError("变更预览不完整");
      }));
    } catch (error) { next(error); }
  });
  return router;
}

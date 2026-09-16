import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CatalogError } from "./catalog-store.js";
import type { AssistantConversation, AssistantPageContext, AssistantProposal } from "../shared/assistant.js";

interface AssistantData { version: 1; conversations: AssistantConversation[] }

export class AssistantStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  private async read(): Promise<AssistantData> {
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8")) as AssistantData;
      if (data.version !== 1 || !Array.isArray(data.conversations)) throw new CatalogError("助手数据格式不正确", 500);
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, conversations: [] };
    }
  }

  private async mutate<T>(operation: (data: AssistantData) => T | Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const data = await this.read();
      const value = await operation(data);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      return structuredClone(value);
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private find(data: AssistantData, productId: string, id: string) {
    const conversation = data.conversations.find((item) => item.id === id && item.productId === productId);
    if (!conversation) throw new CatalogError("助手对话不存在", 404);
    return conversation;
  }

  async list(productId: string) {
    return (await this.read()).conversations.filter((item) => item.productId === productId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(({ id, title, status, createdAt, updatedAt }) => ({ id, title, status, createdAt, updatedAt }));
  }

  async get(productId: string, id: string): Promise<AssistantConversation> {
    return structuredClone(this.find(await this.read(), productId, id));
  }

  async create(productId: string): Promise<AssistantConversation> {
    return this.mutate((data) => {
      const timestamp = new Date().toISOString();
      const conversation: AssistantConversation = {
        id: randomUUID(), productId, title: "新对话", status: "idle", messages: [], proposals: [], createdAt: timestamp, updatedAt: timestamp,
      };
      data.conversations.push(conversation);
      return conversation;
    });
  }

  async startTurn(productId: string, id: string, content: string, runId: string, context: AssistantPageContext) {
    return this.mutate((data) => {
      const conversation = this.find(data, productId, id);
      if (conversation.status === "running") throw new CatalogError("助手仍在处理上一条消息", 409);
      if (!content.trim() || content.length > 8_000) throw new CatalogError("消息须包含 1 至 8000 个字符");
      const timestamp = new Date().toISOString();
      if (!conversation.messages.length) conversation.title = content.trim().slice(0, 60);
      conversation.messages.push({ id: randomUUID(), role: "user", content: content.trim(), runId, context, createdAt: timestamp });
      conversation.status = "running";
      conversation.activeRunId = runId;
      conversation.updatedAt = timestamp;
      return conversation;
    });
  }

  async finishTurn(productId: string, id: string, runId: string, content: string, error = false) {
    return this.mutate((data) => {
      const conversation = this.find(data, productId, id);
      if (conversation.activeRunId !== runId) throw new CatalogError("助手任务与对话不匹配", 409);
      const timestamp = new Date().toISOString();
      conversation.messages.push({ id: randomUUID(), role: "assistant", content: content.trim().slice(0, 40_000) || "模型未返回回复", runId, error, createdAt: timestamp });
      conversation.status = "idle";
      delete conversation.activeRunId;
      conversation.updatedAt = timestamp;
      return conversation;
    });
  }

  async propose(productId: string, id: string, proposal: Omit<AssistantProposal, "id" | "status" | "createdAt">) {
    return this.mutate((data) => {
      const conversation = this.find(data, productId, id);
      if (conversation.activeRunId !== proposal.runId) throw new CatalogError("助手任务已结束", 409);
      if (conversation.proposals.filter((item) => item.runId === proposal.runId).length >= 20) throw new CatalogError("单轮最多生成 20 份变更预览");
      const next: AssistantProposal = { ...proposal, id: randomUUID(), status: "pending", createdAt: new Date().toISOString() };
      conversation.proposals.push(next);
      conversation.updatedAt = next.createdAt;
      return next;
    });
  }

  async resolveProposal(productId: string, id: string, proposalId: string, decision: "apply" | "reject", apply: (proposal: AssistantProposal) => Promise<void>) {
    return this.mutate(async (data) => {
      const conversation = this.find(data, productId, id);
      if (conversation.status === "running") throw new CatalogError("请等待助手结束本轮回复再确认变更", 409);
      const proposal = conversation.proposals.find((item) => item.id === proposalId);
      if (!proposal) throw new CatalogError("变更预览不存在", 404);
      if (proposal.status !== "pending") throw new CatalogError("这份变更已经处理", 409);
      if (decision === "apply") await apply(proposal);
      proposal.status = decision === "apply" ? "applied" : "rejected";
      conversation.updatedAt = new Date().toISOString();
      return conversation;
    });
  }

  async failInterruptedConversations(reason: string) {
    return this.mutate((data) => {
      let count = 0;
      for (const conversation of data.conversations) {
        if (conversation.status !== "running") continue;
        const timestamp = new Date().toISOString();
        conversation.messages.push({ id: randomUUID(), role: "assistant", content: reason, error: true, runId: conversation.activeRunId || "", createdAt: timestamp });
        conversation.proposals.filter((item) => item.runId === conversation.activeRunId && item.status === "pending").forEach((item) => { item.status = "rejected"; });
        conversation.status = "idle";
        delete conversation.activeRunId;
        conversation.updatedAt = timestamp;
        count += 1;
      }
      return count;
    });
  }
}

export const assistantStore = new AssistantStore(path.resolve(process.cwd(), ".data", "assistant.json"));

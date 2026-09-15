import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CatalogError } from "./catalog-store.js";

export type DiagnosticConversationStatus = "idle" | "running";

export interface DiagnosticMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  runId: string;
  createdAt: string;
}

export interface DiagnosticConversation {
  id: string;
  productId: string;
  testRunId: string;
  caseRunId: string;
  title: string;
  status: DiagnosticConversationStatus;
  activeRunId?: string;
  messages: DiagnosticMessage[];
  createdAt: string;
  updatedAt: string;
}

interface DiagnosticData {
  version: 1;
  conversations: DiagnosticConversation[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultData(): DiagnosticData {
  return { version: 1, conversations: [] };
}

export class DiagnosticStore {
  private initializePromise?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async write(data: DiagnosticData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private async initialize(): Promise<void> {
    try {
      await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.write(defaultData());
    }
  }

  private async read(): Promise<DiagnosticData> {
    this.initializePromise ??= this.initialize();
    await this.initializePromise;
    const data = JSON.parse(await readFile(this.filePath, "utf8")) as DiagnosticData;
    if (data.version !== 1 || !Array.isArray(data.conversations)) {
      throw new CatalogError("诊断数据文件格式不正确", 500);
    }
    return data;
  }

  private async mutate<T>(operation: (data: DiagnosticData) => T | Promise<T>): Promise<T> {
    let result!: T;
    const mutation = this.mutationQueue.then(async () => {
      const data = await this.read();
      result = await operation(data);
      await this.write(data);
    });
    this.mutationQueue = mutation.then(() => undefined, () => undefined);
    await mutation;
    return clone(result);
  }

  async list(productId: string, testRunId: string, caseRunId: string): Promise<DiagnosticConversation[]> {
    const data = await this.read();
    return data.conversations
      .filter((item) => item.productId === productId && item.testRunId === testRunId && item.caseRunId === caseRunId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(clone);
  }

  async get(productId: string, id: string): Promise<DiagnosticConversation> {
    const data = await this.read();
    const conversation = data.conversations.find((item) => item.id === id && item.productId === productId);
    if (!conversation) throw new CatalogError("诊断对话不存在", 404);
    return clone(conversation);
  }

  async create(productId: string, testRunId: string, caseRunId: string, title: string): Promise<DiagnosticConversation> {
    return this.mutate((data) => {
      const timestamp = new Date().toISOString();
      const conversation: DiagnosticConversation = {
        id: randomUUID(),
        productId,
        testRunId,
        caseRunId,
        title: title.trim().slice(0, 200) || "用例诊断",
        status: "idle",
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.conversations.push(conversation);
      return conversation;
    });
  }

  async getOrCreate(
    productId: string,
    testRunId: string,
    caseRunId: string,
    title: string,
  ): Promise<DiagnosticConversation> {
    return this.mutate((data) => {
      const existing = data.conversations
        .filter((item) => item.productId === productId && item.testRunId === testRunId && item.caseRunId === caseRunId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (existing) return existing;

      const timestamp = new Date().toISOString();
      const conversation: DiagnosticConversation = {
        id: randomUUID(),
        productId,
        testRunId,
        caseRunId,
        title: title.trim().slice(0, 200) || "用例诊断",
        status: "idle",
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.conversations.push(conversation);
      return conversation;
    });
  }

  async startTurn(productId: string, id: string, question: string, runId: string): Promise<DiagnosticConversation> {
    return this.mutate((data) => {
      const conversation = data.conversations.find((item) => item.id === id && item.productId === productId);
      if (!conversation) throw new CatalogError("诊断对话不存在", 404);
      if (conversation.status === "running") throw new CatalogError("当前诊断问题仍在处理中", 409);
      const content = question.trim();
      if (!content) throw new CatalogError("请输入诊断问题");
      if (content.length > 8_000) throw new CatalogError("诊断问题不能超过 8000 个字符");
      const timestamp = new Date().toISOString();
      conversation.messages.push({
        id: randomUUID(),
        role: "user",
        content,
        runId,
        createdAt: timestamp,
      });
      conversation.status = "running";
      conversation.activeRunId = runId;
      conversation.updatedAt = timestamp;
      return conversation;
    });
  }

  async finishTurn(
    productId: string,
    id: string,
    runId: string,
    content: string,
    error = false,
  ): Promise<DiagnosticConversation> {
    return this.mutate((data) => {
      const conversation = data.conversations.find((item) => item.id === id && item.productId === productId);
      if (!conversation) throw new CatalogError("诊断对话不存在", 404);
      if (conversation.activeRunId !== runId) throw new CatalogError("诊断任务与当前对话不匹配", 409);
      const timestamp = new Date().toISOString();
      const normalizedContent = content.trim();
      conversation.messages.push({
        id: randomUUID(),
        role: "assistant",
        content: normalizedContent
          ? `${normalizedContent.slice(0, 40_000)}${normalizedContent.length > 40_000 ? "\n\n（回复已截断）" : ""}`
          : error ? "诊断失败，模型未返回具体原因" : "模型未返回诊断内容",
        error,
        runId,
        createdAt: timestamp,
      });
      conversation.status = "idle";
      delete conversation.activeRunId;
      conversation.updatedAt = timestamp;
      return conversation;
    });
  }

  async failInterruptedConversations(reason: string): Promise<number> {
    return this.mutate((data) => {
      let count = 0;
      const timestamp = new Date().toISOString();
      for (const conversation of data.conversations) {
        if (conversation.status !== "running" || !conversation.activeRunId) continue;
        conversation.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: reason,
          error: true,
          runId: conversation.activeRunId,
          createdAt: timestamp,
        });
        conversation.status = "idle";
        delete conversation.activeRunId;
        conversation.updatedAt = timestamp;
        count += 1;
      }
      return count;
    });
  }
}

export const diagnosticStore = new DiagnosticStore(path.resolve(process.cwd(), ".data", "diagnostics.json"));

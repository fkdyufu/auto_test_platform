export type AssetKind = "device" | "scenario" | "case" | "order";
export interface AssetChange {
  kind: AssetKind;
  operation: "create" | "update" | "delete";
  id?: string;
  values?: Record<string, unknown>;
}
export interface AssetDifference {
  kind: AssetKind;
  id: string;
  name: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
export interface AssetPreview {
  revision: string;
  changes: AssetChange[];
  differences: AssetDifference[];
}
export interface AssistantPageContext {
  page: string;
  title: string;
  assetKind?: AssetKind;
  assetId?: string;
  draft?: Record<string, unknown>;
  draftToken?: string;
}
export interface AssistantProposal {
  id: string;
  runId: string;
  summary: string;
  target: "assets" | "draft";
  status: "pending" | "applied" | "rejected";
  preview?: AssetPreview;
  context?: AssistantPageContext;
  values?: Record<string, unknown>;
  createdAt: string;
}
export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId: string;
  error?: boolean;
  createdAt: string;
  context?: AssistantPageContext;
}
export interface AssistantConversation {
  id: string;
  productId: string;
  title: string;
  status: "idle" | "running";
  activeRunId?: string;
  messages: AssistantMessage[];
  proposals: AssistantProposal[];
  createdAt: string;
  updatedAt: string;
}

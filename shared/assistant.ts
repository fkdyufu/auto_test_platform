import type { LabLinkRole, LabPortKind } from "./physical-lab.js";

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
export interface LabPortRef {
  node: string;
  port: string;
}
/** One edit to the physical lab. Nodes and ports are named as the lab shows them (an ID also works). */
export interface LabOperation {
  op: "add_ports" | "remove_ports" | "update_port" | "connect" | "disconnect" | "update_link" | "set_control_port" | "set_rules" | "add_node" | "rename_node" | "remove_node";
  node?: string;
  port?: string;
  /** Port names for add_ports/remove_ports, e.g. "1-24, console". */
  ports?: string;
  kind?: LabPortKind;
  name?: string;
  a?: LabPortRef;
  b?: LabPortRef;
  role?: LabLinkRole;
  note?: string;
  controlInterfaceId?: string;
  rules?: string;
}
/** One line of a lab change preview; `before`/`after` are set for edits. */
export interface LabChange {
  type: "add" | "remove" | "update";
  text: string;
  before?: string;
  after?: string;
}
export interface LabPreview {
  operations: LabOperation[];
  changes: LabChange[];
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
  target: "assets" | "draft" | "lab";
  status: "pending" | "applied" | "rejected";
  preview?: AssetPreview;
  labPreview?: LabPreview;
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

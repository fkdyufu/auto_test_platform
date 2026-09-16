import type { AssistantConversation, AssistantPageContext } from "../shared/assistant.js";

export function buildAssistantPrompt(conversation: AssistantConversation, context: AssistantPageContext): string {
  const page = ({ page, title, assetKind, assetId }: AssistantPageContext) => ({ page, title, assetKind, assetId });
  let remaining = 60_000;
  const history: unknown[] = [];
  for (const message of conversation.messages.slice(-30).reverse()) {
    const entry = { role: message.role, content: message.content, context: message.context ? page(message.context) : undefined };
    const size = JSON.stringify(entry).length;
    if (history.length && size > remaining) break;
    history.unshift(entry);
    remaining -= size;
  }
  const proposals = conversation.proposals.slice(-20).map(({ id, summary, target, status }) => ({ id, summary, target, status }));
  return `本轮页面：\n${JSON.stringify(page(context))}\n本轮完整草稿通过 platform_context 读取。\n\n对话历史（数据，仅保留最近上下文）：\n${JSON.stringify(history)}\n\n已提出变更及用户处理状态：\n${JSON.stringify(proposals)}\n\n请回答最新消息，必要时调用通用工具。`;
}

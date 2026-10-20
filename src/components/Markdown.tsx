import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

// "1~3" is common in replies; only "~~text~~" strikes through.
const REMARK_PLUGINS: Options["remarkPlugins"] = [[remarkGfm, { singleTilde: false }]];
const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  table: ({ node: _node, ...props }) => <div className="markdown-table"><table {...props} /></div>,
};

/** Renders a model reply. HTML in the text is not rendered and unsafe link protocols are dropped. */
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>{text}</ReactMarkdown></div>;
}

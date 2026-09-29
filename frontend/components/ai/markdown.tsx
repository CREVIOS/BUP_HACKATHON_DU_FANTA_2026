import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

// Assistant replies are rendered with react-markdown. It is secure by default:
// raw HTML in the input is not parsed (we do not enable rehype-raw), so there is
// no HTML-injection surface. remark-gfm adds tables, strikethrough, task lists
// and autolinks; remark-breaks keeps single newlines as line breaks, matching
// how the chat model tends to format short replies.
//
// The `components` map below carries the same Tailwind styling the previous
// hand-rolled renderer used, so the visual output is unchanged.

const components: Components = {
  p: ({ children }) => <p className="text-sm leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm leading-relaxed">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-foreground/25 pl-3 text-sm leading-relaxed">{children}</blockquote>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

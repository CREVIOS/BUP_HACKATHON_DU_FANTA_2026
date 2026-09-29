import { Fragment, type ReactNode } from "react";

// A deliberately tiny, safe Markdown renderer for assistant replies: bold
// (**text**), bullet lists (- / * / •) and paragraphs with soft line breaks.
// It builds React elements from text — never dangerouslySetInnerHTML — so there
// is no HTML-injection surface, and anything it does not recognise renders as
// plain text. This keeps chat output readable without a heavy dependency.

const BOLD = /\*\*([^*]+)\*\*/g;
const BULLET = /^\s*[-*•]\s+/;

// renderInline turns **bold** spans into <strong>; everything else is literal.
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(BOLD)) {
    const start = m.index ?? 0;
    if (start > last) out.push(<Fragment key={key++}>{text.slice(last, start)}</Fragment>);
    out.push(<strong key={key++}>{m[1]}</strong>);
    last = start + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/).filter(Boolean);
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split("\n");
        if (lines.length > 0 && lines.every((l) => BULLET.test(l))) {
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
              {lines.map((l, li) => (
                <li key={li}>{renderInline(l.replace(BULLET, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi} className="whitespace-pre-wrap text-sm leading-relaxed">
            {lines.flatMap((l, li) => (li === 0 ? renderInline(l) : [<br key={`br${li}`} />, ...renderInline(l)]))}
          </p>
        );
      })}
    </>
  );
}

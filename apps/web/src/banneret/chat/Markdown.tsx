/* oxlint-disable react/no-array-index-key -- Positions identify static tokens within this message. */
import type { ReactNode } from "react";
const tokens = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
function inline(text: string): ReactNode[] {
  return text.split(tokens).map((part, i) => {
    if (i % 2 === 0) return part;
    if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    const split = part.indexOf("](");
    return (
      <a key={i} href={part.slice(split + 2, -1)} target="_blank" rel="noreferrer">
        {part.slice(1, split)}
      </a>
    );
  });
}
export function Markdown({ text }: { text: string }) {
  return (
    <div data-chat-body>
      {text.split("```").map((block, i) =>
        i % 2 ? (
          <pre key={i}>{block.replace(/^\w*\n/, "")}</pre>
        ) : (
          block.split("\n").map((line, j) => {
            if (line.startsWith("> "))
              return <blockquote key={j}>{inline(line.slice(2))}</blockquote>;
            if (/^[-*] /.test(line))
              return (
                <div role="listitem" key={j}>
                  • {inline(line.slice(2))}
                </div>
              );
            return <div key={j}>{inline(line) || " "}</div>;
          })
        ),
      )}
    </div>
  );
}

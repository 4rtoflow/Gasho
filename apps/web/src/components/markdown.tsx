// Renders Claude's Markdown: CommonMark + GitHub extensions (tables, task lists, strikethrough, autolinks).
// A single newline is a line break, as in chat apps and GitHub comments; Claude often writes one item per line.
// Raw HTML is never rendered. Links go through easyui.site's safeHref; images are shown as links so that
// opening a conversation never loads anything from other servers.
import { Children, isValidElement, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeBlock, safeHref } from "@/components/ui/ai-response";

function Pre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    const lang = /language-([\w+#.-]+)/.exec(child.props.className ?? "")?.[1] ?? "text";
    const code = String(child.props.children ?? "").replace(/\n$/, "");
    return <CodeBlock language={lang} code={code} className="my-3" />;
  }
  return <pre className="my-3 overflow-x-auto">{children}</pre>;
}

const components: Components = {
  pre: Pre,
  code: ({ children }) => (
    <code className="rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-[0.86em] text-foreground">{children}</code>
  ),
  a: ({ href, children }) => {
    const safe = safeHref(href);
    if (!safe) return <span className="underline decoration-dotted decoration-neutral-500 underline-offset-2">{children}</span>;
    return (
      <a
        href={safe}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="break-words underline decoration-neutral-500 underline-offset-2 hover:decoration-current"
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => {
    const safe = safeHref(typeof src === "string" ? src : undefined);
    const label = `画像：${alt || safe || ""}`;
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
        {label}
      </a>
    ) : (
      <span>{label}</span>
    );
  },
  h1: ({ children }) => <h1 className="mt-5 mb-2 text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1.5 text-sm font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-semibold">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-3 mb-1 text-sm font-medium">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-3 mb-1 text-sm font-medium text-muted-foreground">{children}</h6>,
  p: ({ children }) => <p className="my-2">{children}</p>,
  ul: ({ children, className }) => (
    <ul className={className?.includes("contains-task-list") ? "my-2 space-y-1 pl-1" : "my-2 list-disc space-y-1 pl-5"}>{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children, className }) => (
    <li className={className?.includes("task-list-item") ? "list-none [&>p]:my-0" : "[&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1"}>{children}</li>
  ),
  input: ({ checked }) => <input type="checkbox" checked={!!checked} disabled readOnly className="mr-1.5 align-middle" />,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-4 border-border" />,
  del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-raised">{children}</thead>,
  th: ({ children, style }) => (
    <th style={style} className="border-b border-border px-2.5 py-1.5 font-medium whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b border-border/60 px-2.5 py-1.5 align-top">
      {children}
    </td>
  ),
};

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}

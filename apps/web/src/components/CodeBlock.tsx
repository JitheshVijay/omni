// Syntax-highlighted code block for chat markdown. Uses react-syntax-
// highlighter's PrismAsyncLight with a curated set of registered languages.
// The FULL PrismAsync build bundles every Prism grammar (8000+ modules) and
// blows up build memory, so we register only the common ones. The theme is
// LOCKED dark regardless of the app's light/dark mode (deliberate:
// IDE-style token contrast in both themes). A header shows the detected
// language + a copy button. An unregistered language still renders (dark,
// unhighlighted) rather than failing.

import { memo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { PrismAsyncLight as SyntaxHighlighter } from "react-syntax-highlighter";
// Import the ONE theme directly, not via the styles/prism barrel (that index
// pulls in ~40 large style objects).
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import goLang from "react-syntax-highlighter/dist/esm/languages/prism/go";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import markdownLang from "react-syntax-highlighter/dist/esm/languages/prism/markdown";

SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("yaml", yaml);
SyntaxHighlighter.registerLanguage("markup", markup);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("go", goLang);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("java", java);
SyntaxHighlighter.registerLanguage("c", c);
SyntaxHighlighter.registerLanguage("cpp", cpp);
SyntaxHighlighter.registerLanguage("csharp", csharp);
SyntaxHighlighter.registerLanguage("ruby", ruby);
SyntaxHighlighter.registerLanguage("markdown", markdownLang);

// Map the fence token (and common aliases) to a registered Prism id.
const LANG_ALIAS: Record<string, string> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  py: "python",
  python: "python",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  bash: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "markup",
  xml: "markup",
  svg: "markup",
  markup: "markup",
  css: "css",
  scss: "css",
  sql: "sql",
  go: "go",
  golang: "go",
  rs: "rust",
  rust: "rust",
  java: "java",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  cs: "csharp",
  csharp: "csharp",
  rb: "ruby",
  ruby: "ruby",
  md: "markdown",
  markdown: "markdown",
};

// Display name for the header label.
const LANG_LABELS: Record<string, string> = {
  javascript: "JavaScript",
  jsx: "JavaScript",
  typescript: "TypeScript",
  tsx: "TypeScript",
  python: "Python",
  bash: "Shell",
  json: "JSON",
  yaml: "YAML",
  markup: "HTML",
  css: "CSS",
  sql: "SQL",
  go: "Go",
  rust: "Rust",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  ruby: "Ruby",
  markdown: "Markdown",
};

function InlineCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked (insecure context / permissions); no-op */
        }
      }}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-white/50 transition-colors hover:bg-white/10 hover:text-white"
      title={copied ? "Copied" : "Copy code"}
      aria-label={copied ? "Copied" : "Copy code"}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

// Memoized on (code, lang): Prism tokenization of a large block is the
// dominant render cost. Both props are primitive strings, so when a parent
// re-renders for an unrelated reason (typing in the composer), memo skips
// re-highlighting unchanged code.
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  const resolved = LANG_ALIAS[lang.toLowerCase()] ?? lang.toLowerCase();
  const label = LANG_LABELS[resolved] ?? (lang === "text" ? "Code" : lang.toUpperCase());
  return (
    <div className="group/code my-2.5 overflow-hidden rounded-lg border border-white/10 bg-[#282c34]">
      {/* The body is intentionally locked dark in both app themes; it reads as
          a deliberate editor card sitting inside the hairline border. */}
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-white/60">
          {label}
        </span>
        <InlineCopyButton text={code} />
      </div>
      <SyntaxHighlighter
        language={resolved}
        style={oneDark}
        // The theme renders its own <pre>; strip its margin/radius so it sits
        // flush. background:transparent lets the container's #282c34 show.
        customStyle={{
          margin: 0,
          background: "transparent",
          padding: "0.75rem 0.875rem",
          fontSize: "13px",
          lineHeight: 1.55,
        }}
        codeTagProps={{
          style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
});

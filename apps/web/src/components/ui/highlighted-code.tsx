import { useEffect, useMemo, useState } from "react";

import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightTree } from "@lezer/highlight";

import { cn } from "@/lib/utils";

interface Fragment {
  text: string;
  className: string;
}

/* Highlighted code block for static documentation snippets. Loads the
 * requested CodeMirror language asynchronously and falls back to plain
 * monospace text until the parser resolves. Token spans use the same
 * `tok-*` classes already styled in `index.css`. */
interface HighlightedCodeProps {
  code: string;
  /** CodeMirror language name (e.g. "YAML", "JSON") or alias ("yaml"). */
  language: string;
  className?: string;
  "data-testid"?: string;
}

const supportCache = new Map<string, Promise<LanguageSupport | null>>();

async function loadLanguage(
  language: string,
): Promise<LanguageSupport | null> {
  const key = language.toLowerCase();
  const cached = supportCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const desc = LanguageDescription.matchLanguageName(languages, language, true);
    if (!desc) return null;
    try {
      if (desc.support) return desc.support;
      return await desc.load();
    } catch {
      return null;
    }
  })();
  supportCache.set(key, promise);
  return promise;
}

function tokenize(text: string, support: LanguageSupport): Fragment[] {
  const tree = support.language.parser.parse(text);
  const out: Fragment[] = [];
  let cursor = 0;
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > cursor) {
      out.push({ text: text.slice(cursor, from), className: "" });
    }
    out.push({ text: text.slice(from, to), className: classes });
    cursor = to;
  });
  if (cursor < text.length) {
    out.push({ text: text.slice(cursor), className: "" });
  }
  return out;
}

export function HighlightedCode({
  code,
  language,
  className,
  "data-testid": testId,
}: HighlightedCodeProps) {
  const [support, setSupport] = useState<LanguageSupport | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadLanguage(language).then((res) => {
      if (!cancelled) setSupport(res);
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const fragments = useMemo<Fragment[] | null>(() => {
    if (!support) return null;
    try {
      return tokenize(code, support);
    } catch {
      return null;
    }
  }, [code, support]);

  return (
    <pre
      data-testid={testId}
      data-language={language.toLowerCase()}
      className={cn(
        "my-3 overflow-auto rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--chip-bg)] px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] text-[color:var(--ink)]",
        className,
      )}
    >
      {fragments
        ? fragments.map((f, i) =>
            f.className ? (
              <span key={i} className={f.className}>
                {f.text}
              </span>
            ) : (
              <span key={i}>{f.text}</span>
            ),
          )
        : code}
    </pre>
  );
}

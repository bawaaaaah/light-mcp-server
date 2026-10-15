import { useState } from "react";
import { useT } from "../App";

/** Copies `text`; when the clipboard is refused (plain HTTP, permissions) the text stays selectable. */
export function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  return (
    <button type="button" className="copy" onClick={copy}>
      {copied ? `✔ ${t.copied}` : t.copy}
    </button>
  );
}

/** A snippet to paste; `display` is what is shown (a masked token), `code` what is copied. */
export function CodeBlock({ code, display }: { code: string; display?: string }) {
  return (
    <div className="code-block">
      <pre>
        <code>{display ?? code}</code>
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

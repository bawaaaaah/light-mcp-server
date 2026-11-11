/**
 * Where the intentions a song or a look names come from (T15, decision of 2026-11-11): the show, this
 * machine's library (personal or private file), shipped, or unknown here. Read from `knowledge.get`
 * once when shown; the words are the song's mood or the look's `ambiance:` tags.
 */
import { useEffect, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { originsOf, type KnowledgeIntentions } from "../intentions";

export function IntentionOrigins({ words }: { words: readonly string[] }): ReactElement | null {
  const t = useT();
  const [kb, setKb] = useState<KnowledgeIntentions | null>(null);
  useEffect(() => void cmd<KnowledgeIntentions>("knowledge.get").then(setKb).catch(() => undefined), []);
  if (!kb || words.length === 0) return null;
  return (
    <ul className="intention-origins" aria-label={t.intentions}>
      {originsOf(kb, words).map((o) => (
        <li key={o.word} className={`chip origin-${o.origin}`}>
          {o.label} · {o.origin === "unknown" ? t.intentionUnknown : o.hidden ? t.intentionHidden : t.intentionOrigins[o.origin]}
        </li>
      ))}
    </ul>
  );
}

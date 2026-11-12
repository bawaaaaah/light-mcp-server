/**
 * Where the intentions a song or a look names come from (T15, decision of 2026-11-11): the show, this
 * machine's library (personal or private file), shipped, or unknown here. Read from `knowledge.get`
 * once when shown (or given); the words are the song's mood or the look's `ambiance:` tags. A label
 * several intentions bear (T15b) is said, and `onPick` lets the user choose which one the word names
 * (by its id).
 */
import { useEffect, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { bearersOf, fill, originsOf, resolveWord, type KnowledgeIntentions } from "../intentions";

export function IntentionOrigins({ words, kb: given, onPick }: { words: readonly string[]; kb?: KnowledgeIntentions | null; onPick?: (word: string, id: string) => void }): ReactElement | null {
  const t = useT();
  const [read, setRead] = useState<KnowledgeIntentions | null>(null);
  useEffect(() => {
    if (given === undefined) void cmd<KnowledgeIntentions>("knowledge.get").then(setRead).catch(() => undefined);
  }, [given]);
  const kb = given ?? read;
  if (!kb || words.length === 0) return null;
  return (
    <div className="intention-origins">
      <span className="hint">
        {t.intentions}
        {t.colon}
      </span>
      <ul aria-label={t.intentions}>
        {originsOf(kb, words).map((o) => {
          // a label shared: the others that bear it, to pick another one (T15b)
          const bearers = o.origin === "unknown" ? [] : bearersOf(kb, o.label);
          const others = bearers.length > 1 ? bearers : [];
          const current = resolveWord(kb, o.word);
          return (
            <li key={o.word} className={`chip origin-${o.origin}${others.length ? " shared" : ""}`}>
              {o.label} · {o.origin === "unknown" ? t.intentionUnknown : o.hidden ? t.intentionHidden : t.intentionOrigins[o.origin]}
              {others.length > 0 && (
                <>
                  {" "}
                  <small className="warn">{fill(t.intentionShared, { n: others.length })}</small>
                  {onPick && (
                    <select aria-label={fill(t.intentionPickOther, { name: o.label })} value={current?.id ?? ""} onChange={(e) => onPick(o.word, e.target.value)}>
                      {others.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label} · {t.intentionOrigins[c.origin]}
                        </option>
                      ))}
                    </select>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

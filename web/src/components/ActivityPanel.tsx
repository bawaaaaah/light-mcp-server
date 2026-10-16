import { useCallback, useEffect, useRef, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";

interface Entry {
  at: number;
  until: number;
  count: number;
  name: string;
  title: string;
  origin: "ui" | "midi" | "osc" | "mcp" | "timeline" | "cli" | "system";
  who?: string;
  target?: string;
  ok: boolean;
  error?: string;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * What changed since the server started (activity.list): when, who, from where, what, on which
 * object. Read again at most once a second while commands come in.
 */
export function ActivityPanel() {
  const t = useT();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const timer = useRef<number | null>(null);
  const load = useCallback(() => void cmd<Entry[]>("activity.list", { limit: 100 }).then(setEntries, () => undefined), []);
  useEffect(load, [load]);
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);
  useCommandEvents([""], () => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      load();
    }, 1000);
  });
  return (
    <>
      <h2>{t.activity}</h2>
      <p className="hint">{t.activityHelp}</p>
      {entries?.length === 0 && <p className="hint">{t.noActivity}</p>}
      {entries && entries.length > 0 && (
        <div>
          <table className="activity">
            <tbody>
              {entries.map((e) => (
                <tr key={`${e.at}-${e.name}-${e.target ?? ""}-${e.who ?? ""}`} className={e.ok ? undefined : "failed"}>
                  <td className="nowrap">
                    {time(e.at)}
                    {e.count > 1 && <small className="hint"> ×{e.count}</small>}
                  </td>
                  <td>{e.who ?? "—"}</td>
                  <td className="hint">{t.origins[e.origin]}</td>
                  <td>
                    {e.title}
                    {e.target && <small className="hint"> · {e.target}</small>}
                  </td>
                  <td title={e.error}>{e.ok ? "✔" : `✖ ${e.error ?? ""}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

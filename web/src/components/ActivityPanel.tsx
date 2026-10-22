import { useCallback, useEffect, useRef, useState } from "react";
import { api, cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";

interface Entry {
  at: number;
  until: number;
  count: number;
  name: string;
  title: string;
  origin: "ui" | "midi" | "osc" | "os2l" | "mcp" | "timeline" | "cli" | "system";
  who?: string;
  target?: string;
  ok: boolean;
  error?: string;
  /** A design change history.undo can take back. */
  undo?: { collection: string; id: string };
}

interface Client {
  who: string;
  role?: string;
  address?: string;
  since: string;
  self: boolean;
}

/** Who has the interface open right now (one line per open page), read every 5 s. */
export function OnlinePanel() {
  const t = useT();
  const [clients, setClients] = useState<Client[] | null>(null);
  useEffect(() => {
    const load = () => void api<Client[]>("/api/clients").then(setClients, () => undefined);
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <h2>
        {t.online} {clients && `(${clients.length})`}
      </h2>
      <ul className="online">
        {clients?.map((c, i) => (
          <li key={`${c.since}-${i}`}>
            <strong>{c.who}</strong>
            {c.role && c.role !== c.who && <small className="hint"> · {c.role}</small>}
            {c.self && <span className="badge"> {t.thisPage}</span>}
            <small className="hint">
              {" "}
              · {c.address ?? "?"} · {t.since} {time(Date.parse(c.since))}
            </small>
          </li>
        ))}
      </ul>
    </>
  );
}

const time = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * What changed since the server started (activity.list): when, who, from where, what, on which
 * object. Read again at most once a second while commands come in. A change to a look, group,
 * channel fader or dashboard can be undone from its line (history.undo), after saying what was
 * changed on that object since, and by whom.
 */
export function ActivityPanel() {
  const t = useT();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [who, setWho] = useState("");
  const [origin, setOrigin] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<number | null>(null);
  const load = useCallback(() => void cmd<Entry[]>("activity.list", { limit: 300 }).then(setEntries, () => undefined), []);
  useEffect(load, [load]);
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);
  const shown = entries?.filter((e) => (!who || (e.who ?? "—") === who) && (!origin || e.origin === origin) && (!failedOnly || !e.ok));
  const undo = (e: Entry) => {
    const since = (entries ?? []).filter((x) => x.target === e.target && x.undo && x.at > e.until).reverse();
    const question = [`« ${e.target} » : ${t.undoQuestion} (${time(e.at)}) ?`, ...(since.length ? [`\n${t.undoAlso}`, ...since.map((x) => `• ${time(x.at)} · ${x.who ?? "—"} · ${x.title}`)] : [])].join("\n");
    if (!confirm(question)) return;
    setError("");
    void cmd("history.undo", { ...e.undo, at: e.at, until: e.until }).then(load, (err: Error) => setError(err.message));
  };
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
        <div className="row activity-filters">
          <select aria-label={t.activityWho} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">{t.activityEveryone}</option>
            {[...new Set(entries.map((e) => e.who ?? "—"))].sort().map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <select aria-label={t.activityOrigin} value={origin} onChange={(e) => setOrigin(e.target.value)}>
            <option value="">{t.activityEverywhere}</option>
            {[...new Set(entries.map((e) => e.origin))].map((o) => (
              <option key={o} value={o}>
                {t.origins[o]}
              </option>
            ))}
          </select>
          <label className="inline">
            <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> {t.activityFailedOnly}
          </label>
        </div>
      )}
      {shown && shown.length === 0 && entries && entries.length > 0 && <p className="hint">{t.activityNoMatch}</p>}
      {error && <p className="error">{error}</p>}
      {shown && shown.length > 0 && (
        <div>
          <table className="activity">
            <tbody>
              {shown.map((e) => (
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
                  <td>
                    {e.undo && (
                      <button className="ghost" title={t.undoChange} aria-label={`${t.undoChange} · ${e.title} · ${e.target}`} onClick={() => undo(e)}>
                        ↶
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Proposals (docs/specs/mcp.md, « Proposer puis appliquer »): changes an AI client (or anyone with
 * show:propose) held together without writing them. Each shows who made it and what it would change,
 * field by field; someone who may write applies it all or nothing, takes it back, or applies it again.
 * Hidden while there is nothing to decide.
 */
import { useCallback, useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";

interface Preview {
  command: string;
  valid: boolean;
  collection: string;
  id?: string;
  new?: boolean;
  changes?: { path: string; before?: unknown; after?: unknown }[];
  issues?: string[];
}
interface Proposal {
  id: string;
  title?: string;
  who?: string;
  origin: string;
  at: number;
  status: "pending" | "applied" | "reverted" | "discarded";
  appliedBy?: string;
  preview: Preview[];
}

/** A value as it reads in one line. */
const short = (v: unknown) => {
  const s = v === undefined ? "—" : typeof v === "string" ? `« ${v} »` : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function Proposals({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [list, setList] = useState<Proposal[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(() => void cmd<Proposal[]>("show.proposals").then(setList, () => setList([])), []);
  useEffect(load, [load]);
  useCommandEvents(["show.propose", "show.apply", "show.revert", "show.discard"], load);
  const act = (name: string, id: string) => {
    setError("");
    void cmd(name, { id }).then(
      () => (load(), onChanged()),
      (e: Error) => setError(e.message),
    );
  };
  const shown = list.filter((p) => p.status !== "discarded").slice(0, 5);
  if (!shown.length) return null;
  return (
    <section className="proposals">
      <h2>{t.proposals}</h2>
      <p className="hint">{t.proposalsHelp}</p>
      {error && <p className="error">{error}</p>}
      {shown.map((p) => (
        <div key={p.id} className={`proposal ${p.status}`}>
          <div className="row">
            <strong>{p.title ?? t.proposal}</strong>
            <small className="hint">
              {p.who ?? "—"} · {t.origins[p.origin as keyof typeof t.origins] ?? p.origin} · {time(p.at)}
            </small>
            <span className="badge">{t.proposalStatus[p.status]}</span>
            <span className="grow" />
            {p.status === "pending" && (
              <>
                <button className="primary" onClick={() => act("show.apply", p.id)}>
                  {t.proposalApply}
                </button>
                <button onClick={() => act("show.discard", p.id)}>{t.proposalDiscard}</button>
              </>
            )}
            {p.status === "applied" && <button onClick={() => act("show.revert", p.id)}>↶ {t.proposalRevert}</button>}
            {p.status === "reverted" && (
              <>
                <button onClick={() => act("show.apply", p.id)}>↷ {t.proposalRedo}</button>
                <button onClick={() => act("show.discard", p.id)}>{t.proposalDiscard}</button>
              </>
            )}
          </div>
          <ul>
            {p.preview.map((c, i) => (
              <li key={i}>
                <code>{c.command}</code> {c.id && <strong>{c.id}</strong>}{" "}
                {!c.valid ? <span className="error">{c.issues?.join(" · ")}</span> : c.new ? <span className="badge">{t.proposalNew}</span> : p.status !== "applied" && !c.changes?.length ? <small className="hint">{t.proposalSame}</small> : null}
                {c.valid && !!c.changes?.length && (
                  <ul className="changes">
                    {c.changes.slice(0, 8).map((d) => (
                      <li key={d.path}>
                        <small>
                          {d.path} : {short(d.before)} → {short(d.after)}
                        </small>
                      </li>
                    ))}
                    {c.changes.length > 8 && <li className="hint">… +{c.changes.length - 8}</li>}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

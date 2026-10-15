import { useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";

interface Proposal {
  applied: boolean;
  report: { converted: string[]; warnings: string[] };
  counts: Record<string, number>;
  collisions?: string[];
  conflicts?: string[];
  otherWorkspace?: string;
  merged?: Record<string, { added: number; updated: number; unchanged: number; kept: string[]; toCheck: string[] }>;
}
interface Rebuild {
  saved: boolean;
  rebuilt: number;
  total: number;
  results: { id: string; name: string; recognised: string; fidelity: number; accepted: boolean; reason: string }[];
}
interface Selftest {
  total: number;
  passed: number;
  failed: { mapping: string; label: string; reason: string }[];
  exclusivity: { group: string; ok: boolean; detail?: string }[];
  latencyMs: { p50: number; max: number };
  cadence?: { bpm: number; looks: { look: string; expectedMs: number; measuredMs?: number; ok: boolean; detail?: string }[] };
}

export function ImportPage() {
  const t = useT();
  const [xml, setXml] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [selftest, setSelftest] = useState<Selftest | null>(null);
  const [rebuild, setRebuild] = useState<Rebuild | null>(null);
  const [error, setError] = useState("");
  const [withCadence, setWithCadence] = useState(false);
  const [running, setRunning] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    const text = await file.text();
    setXml(text);
    try {
      setProposal(await cmd<Proposal>("import.qxw", { xml: text }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="import">
      <section>
        <h2>{t.importTitle}</h2>
        <p className="hint">{t.importHelp}</p>
        <label className="button-like primary">
          ⤒ {t.chooseQxw}
          <input type="file" accept=".qxw" hidden onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        {error && <p className="error">{error}</p>}
        {proposal && (
          <div className="report">
            <h3>{proposal.applied ? "✔" : t.dryRun}</h3>
            <ul>
              {proposal.report.converted.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            {proposal.report.warnings.length > 0 && (
              <>
                <h3>{t.warnings}</h3>
                <ul className="warnings">
                  {proposal.report.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </>
            )}
            {(proposal.conflicts?.length ?? 0) + (proposal.collisions?.length ?? 0) > 0 && (
              <>
                <h3>{t.noteConflicts}</h3>
                <ul className="warnings">
                  {[...(proposal.conflicts ?? []), ...(proposal.collisions ?? [])].map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </>
            )}
            {proposal.merged && (
              <>
                <h3>{t.reimport}</h3>
                <table className="merged">
                  <tbody>
                    {Object.entries(proposal.merged)
                      .filter(([, m]) => m.added + m.updated + m.unchanged + m.kept.length + m.toCheck.length > 0)
                      .map(([name, m]) => (
                        <tr key={name}>
                          <td>{t.importCollections[name as keyof typeof t.importCollections] ?? name}</td>
                          <td>
                            +{m.added} · ~{m.updated} · ={m.unchanged}
                          </td>
                          <td>
                            {m.kept.length > 0 && (
                              <small>
                                {t.keptByHand} : {m.kept.join(", ")}
                              </small>
                            )}{" "}
                            {m.toCheck.length > 0 && (
                              <small className="warn">
                                {t.toCheck} : {m.toCheck.join(", ")}
                              </small>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </>
            )}
            {proposal.otherWorkspace && <p className="error">⚠ {proposal.otherWorkspace}</p>}
            {!proposal.applied && xml && (
              <button className="primary" disabled={!!proposal.otherWorkspace} onClick={() => void cmd<Proposal>("import.qxw", { xml, apply: true }).then(setProposal).catch((e: Error) => setError(e.message))}>
                {t.apply}
              </button>
            )}
          </div>
        )}
      </section>
      <section>
        <h2>{t.rebuild}</h2>
        <p className="hint">{t.rebuildHelp}</p>
        <button onClick={() => void cmd<Rebuild>("look.rebuild").then(setRebuild).catch((e: Error) => setError(e.message))}>{t.dryRun}</button>
        {rebuild && !rebuild.saved && rebuild.rebuilt > 0 && (
          <button className="primary" onClick={() => void cmd<Rebuild>("look.rebuild", { save: true }).then(setRebuild).catch((e: Error) => setError(e.message))}>
            {t.apply} ({rebuild.rebuilt})
          </button>
        )}
        {rebuild && (
          <div className="report">
            <p>
              {rebuild.rebuilt}/{rebuild.total}
            </p>
            <table>
              <tbody>
                {rebuild.results.map((r) => (
                  <tr key={r.id} className={r.accepted ? "" : "muted"}>
                    <td>{r.name}</td>
                    <td>{r.recognised}</td>
                    <td>{Math.round(r.fidelity * 100)} %</td>
                    <td>{r.accepted ? "✔" : r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section>
        <h2>{t.selftest}</h2>
        <div className="row">
          <button
            disabled={running}
            onClick={() => {
              setRunning(true);
              void cmd<Selftest>("selftest.run", { cadence: withCadence })
                .then(setSelftest)
                .catch((e: Error) => setError(e.message))
                .finally(() => setRunning(false));
            }}
          >
            {running ? "…" : t.runSelftest}
          </button>
          <label className="row">
            <input type="checkbox" checked={withCadence} onChange={(e) => setWithCadence(e.target.checked)} /> {t.measureCadence}
          </label>
        </div>
        {selftest && (
          <div className="report">
            <p>
              {selftest.passed}/{selftest.total} {t.passed} · {selftest.latencyMs.p50} ms (max {selftest.latencyMs.max} ms)
            </p>
            <ul className="warnings">
              {selftest.failed.map((f) => (
                <li key={f.mapping}>
                  {f.label || f.mapping} : {f.reason}
                </li>
              ))}
              {selftest.exclusivity
                .filter((e) => !e.ok)
                .map((e) => (
                  <li key={e.group}>
                    {e.group} : {e.detail}
                  </li>
                ))}
            </ul>
            {selftest.cadence && (
              <table className="cadence">
                <caption>
                  {t.cadence} · {selftest.cadence.bpm} BPM · {selftest.cadence.looks.filter((c) => c.ok).length}/{selftest.cadence.looks.length}
                </caption>
                <tbody>
                  {selftest.cadence.looks.map((c) => (
                    <tr key={c.look} className={c.ok ? "" : "error"}>
                      <td>{c.ok ? "✔" : "✖"}</td>
                      <td>{c.look}</td>
                      <td>
                        {c.measuredMs ?? "—"} / {c.expectedMs} ms
                      </td>
                      <td>
                        <small>{c.detail}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

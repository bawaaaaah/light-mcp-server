import { useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";

interface Proposal {
  applied: boolean;
  report: { converted: string[]; warnings: string[] };
  counts: Record<string, number>;
  collisions?: string[];
}
interface Selftest {
  total: number;
  passed: number;
  failed: { mapping: string; label: string; reason: string }[];
  exclusivity: { group: string; ok: boolean; detail?: string }[];
  latencyMs: { p50: number; max: number };
}

export function ImportPage() {
  const t = useT();
  const [xml, setXml] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [selftest, setSelftest] = useState<Selftest | null>(null);
  const [error, setError] = useState("");

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
        <input type="file" accept=".qxw" onChange={(e) => void pick(e.target.files?.[0])} />
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
            {!proposal.applied && xml && (
              <button className="primary" onClick={() => void cmd<Proposal>("import.qxw", { xml, apply: true }).then(setProposal).catch((e: Error) => setError(e.message))}>
                {t.apply}
              </button>
            )}
          </div>
        )}
      </section>
      <section>
        <h2>{t.selftest}</h2>
        <button onClick={() => void cmd<Selftest>("selftest.run").then(setSelftest).catch((e: Error) => setError(e.message))}>{t.runSelftest}</button>
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
          </div>
        )}
      </section>
    </div>
  );
}

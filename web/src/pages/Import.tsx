import { useEffect, useState } from "react";
import { cmd, switchingShow } from "../api";
import { useT } from "../App";

interface Proposal {
  applied: boolean;
  report: { converted: string[]; warnings: string[]; missingDefinitions?: string[] };
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

type Target = "open" | "new";
interface DefinitionResult {
  file: string;
  ok: boolean;
  detail: string;
}
/** The result of an import into a new show, kept across the reload that opening it causes. */
const LAST_IMPORT = "lastImport";

/**
 * Guided QLC+ import: 1. fixture definitions (.qxf), 2. the workspace (.qxw) into the open show or a
 * new show of its own, proposal then apply, 3. rebuild into techniques, 4. self-test.
 */
export function ImportPage() {
  const t = useT();
  const [xml, setXml] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [target, setTarget] = useState<Target>("open");
  const [newShow, setNewShow] = useState({ name: "", venue: "new" as "new" | "current" });
  const [openShow, setOpenShow] = useState("");
  const [definitions, setDefinitions] = useState<number | null>(null);
  const [added, setAdded] = useState<DefinitionResult[]>([]);
  /** An import into a new show reloads the page: its report and message come back from here, once. */
  const [kept] = useState<{ proposal: Proposal; done?: string } | null>(() => {
    try {
      const saved = sessionStorage.getItem(LAST_IMPORT);
      return saved ? (JSON.parse(saved) as { proposal: Proposal; done?: string }) : null;
    } catch {
      return null;
    }
  });
  // forgotten once the page is shown: a render React drops (Suspense) must not consume it
  useEffect(() => {
    try {
      sessionStorage.removeItem(LAST_IMPORT);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const [done] = useState(kept?.done ?? "");
  const [proposal, setProposal] = useState<Proposal | null>(kept?.proposal ?? null);
  const [selftest, setSelftest] = useState<Selftest | null>(null);
  const [rebuild, setRebuild] = useState<Rebuild | null>(null);
  const [error, setError] = useState("");
  const [withCadence, setWithCadence] = useState(false);
  const [running, setRunning] = useState(false);

  const loadLibrary = () => void cmd<unknown[]>("venue.library").then((l) => setDefinitions(l.length), () => undefined);
  useEffect(() => {
    loadLibrary();
    void cmd<{ name: string; active: boolean }[]>("show.list").then((l) => setOpenShow(l.find((x) => x.active)?.name ?? ""), () => undefined);
  }, []);

  const propose = async (text: string) => {
    setError("");
    try {
      setProposal(await cmd<Proposal>("import.qxw", { xml: text }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setXml(text);
    setFileName(file.name);
    setNewShow((n) => ({ ...n, name: n.name || file.name.replace(/\.qxw$/i, "") }));
    await propose(text);
  };
  const addDefinitions = async (files: FileList | null) => {
    const results: DefinitionResult[] = [];
    for (const f of Array.from(files ?? [])) {
      try {
        const r = await cmd<{ file: string; manufacturer: string; model: string }>("fixture.definition.add", { name: f.name, xml: await f.text() });
        results.push({ file: r.file, ok: true, detail: `${r.manufacturer} ${r.model}` });
      } catch (e) {
        results.push({ file: f.name, ok: false, detail: (e as Error).message });
      }
    }
    setAdded(results);
    loadLibrary();
    if (xml) await propose(xml); // the proposal now sees them
  };
  const apply = () => {
    if (!xml) return;
    if (target === "open") {
      void cmd<Proposal>("import.qxw", { xml, apply: true }).then(setProposal, (e: Error) => setError(e.message));
      return;
    }
    // the report is kept before the reload onto the new show (switchingShow holds the app's own)
    void switchingShow(() => cmd<{ name: string; imported: Proposal }>("show.create", { name: newShow.name.trim(), venue: newShow.venue, qxw: xml })).then(
      (r) => {
        try {
          sessionStorage.setItem(LAST_IMPORT, JSON.stringify({ proposal: r.imported, done: `${t.importNewShowDone} ${r.name}` }));
        } catch {
          /* storage unavailable: the report is only lost */
        }
        location.reload();
      },
      (e: Error) => setError(e.message),
    );
  };
  const missing = proposal?.report.missingDefinitions ?? [];
  const blocked = target === "open" && Boolean(proposal?.otherWorkspace);

  return (
    <div className="import">
      <section className="step">
        <h2>1. {t.importDefinitions}</h2>
        <p className="hint">{t.importDefinitionsHelp}</p>
        <div className="row">
          <span>
            {definitions ?? "…"} {t.definitionsInLibrary}
          </span>
          <label className="button-like">
            ⤒ {t.addQxf}
            <input type="file" accept=".qxf" multiple hidden onChange={(e) => void addDefinitions(e.target.files)} />
          </label>
        </div>
        {added.length > 0 && (
          <ul className="added-definitions">
            {added.map((a) => (
              <li key={a.file} className={a.ok ? "" : "error"}>
                {a.ok ? "✔" : "✖"} {a.file} : {a.detail}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="step">
        <h2>2. {t.importTitle}</h2>
        <p className="hint">{t.importHelp}</p>
        <div className="row">
          <label className="button-like primary">
            ⤒ {t.chooseQxw}
            <input type="file" accept=".qxw" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          {fileName && <code>{fileName}</code>}
        </div>
        <fieldset className="import-target">
          <legend>{t.importInto}</legend>
          <label className="inline">
            <input type="radio" name="target" checked={target === "open"} onChange={() => setTarget("open")} /> {t.intoOpenShow} « {openShow} »
          </label>
          <label className="inline">
            <input type="radio" name="target" checked={target === "new"} onChange={() => setTarget("new")} /> {t.intoNewShow}
          </label>
          {target === "new" && (
            <div className="row">
              <input aria-label={t.showName} placeholder={t.showName} value={newShow.name} onChange={(e) => setNewShow({ ...newShow, name: e.target.value })} />
              <select aria-label={t.venue} value={newShow.venue} onChange={(e) => setNewShow({ ...newShow, venue: e.target.value as "new" | "current" })}>
                <option value="new">{t.newShowVenueNew}</option>
                <option value="current">{t.newShowVenueSame}</option>
              </select>
            </div>
          )}
        </fieldset>
        {error && <p className="error">{error}</p>}
        {done && <p className="hint">✔ {done}</p>}
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
            {missing.length > 0 && (
              <p className="warn">
                {t.missingDefinitionsHint} <small>({missing.join(", ")})</small>
              </p>
            )}
            {blocked && (
              <p className="error">
                ⚠ {proposal.otherWorkspace}{" "}
                <button onClick={() => setTarget("new")}>{t.useNewShow}</button>
              </p>
            )}
            {!proposal.applied && xml && (
              <button className="primary" disabled={blocked || (target === "new" && !newShow.name.trim())} onClick={apply}>
                {target === "new" ? t.createAndImport : t.apply}
              </button>
            )}
          </div>
        )}
      </section>
      <section className="step">
        <h2>3. {t.rebuild}</h2>
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
      <section className="step">
        <h2>4. {t.selftest}</h2>
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

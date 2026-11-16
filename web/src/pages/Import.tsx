import { useEffect, useState, type ReactElement } from "react";
import { ApiError, cmd, switchingShow } from "../api";
import { useT } from "../App";
import { quoted } from "../typography";
import { Modal } from "../components/Modal";

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
  untested: { mapping: string; label: string; reason: string }[];
  exclusivity: { group: string; ok: boolean; detail?: string }[];
  latencyMs: { p50: number; max: number };
  cadence?: { bpm: number; looks: { look: string; expectedMs: number; measuredMs?: number; ok: boolean; detail?: string }[] };
}

type Target = "open" | "new";
interface DefinitionResult {
  file: string;
  ok: boolean;
  detail: string;
  /** A definition refused because another file of that name, or of that model, differs: « Remplacer » opens its plan. */
  retry?: File;
  /** A file of that name holds another model in service: only « Ajouter sous le nom… » is offered. */
  rename?: File;
}
/** What `fixture.definition.add` answers (T40: `unchanged` when the library already had that model the same). */
interface AddedDefinition {
  file: string;
  folder?: "venue" | "shared";
  manufacturer: string;
  model: string;
  unchanged?: true;
  /** The old version « Remplacer » kept in the definitions' trash. */
  previous?: string;
  /** This venue's own copy was replaced: the shared file stays as it was for the other venues. */
  sharedUnchanged?: true;
  usedBy?: { name: string }[];
  otherVenues?: { name: string; fixtures: string[] }[];
}
/** A « Remplacer » plan (`fixture.definition.add` with dryRun). */
interface ReplacePlan extends AddedDefinition {
  target: string;
  replaced?: true;
  lostModes?: string[];
  changedModes?: string[];
  refused?: boolean;
}
/** A file's bytes in base64: a .qxf goes to the server byte for byte (an ISO-8859-1 file stays one, T20b review 3). */
async function fileBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
/** The result of an import into a new show, kept across the reload that opening it causes. */
const LAST_IMPORT = "lastImport";

/**
 * Guided QLC+ import: 1. fixture definitions (.qxf), 2. the workspace (.qxw) into the open show or a
 * new show of its own, proposal then apply, 3. rebuild into techniques, 4. self-test.
 */
export function ImportPage(): ReactElement {
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
  /** What an added definition says: its model, and that nothing was written when the library already had it the same (T40). */
  const addedDetail = (r: AddedDefinition) => `${r.manufacturer} ${r.model}${r.unchanged ? ` — ${t.libraryPage.alreadyThere.replace("{file}", () => r.file)}` : ""}`;
  /** The definition « Remplacer » is asked for: its plan opens in a window. */
  const [replacing, setReplacing] = useState<File | null>(null);
  /** The file name typed for « Ajouter sous le nom… », per refused file. */
  const [renames, setRenames] = useState<Record<string, string>>({});
  const addOne = async (f: File, name = f.name): Promise<DefinitionResult> => {
    try {
      const r = await cmd<AddedDefinition>("fixture.definition.add", { name, base64: await fileBase64(f) });
      return { file: f.name, ok: true, detail: addedDetail(r) };
    } catch (e) {
      const detail = e instanceof ApiError ? e.detail : undefined;
      // another model in service under that file name: never replaced, added under another name instead
      if (detail?.otherModel) return { file: f.name, ok: false, detail: (e as Error).message, rename: f };
      return { file: f.name, ok: false, detail: (e as Error).message, ...(detail?.exists ? { retry: f } : {}) };
    }
  };
  const addDefinitions = async (files: FileList | null) => {
    const results: DefinitionResult[] = [];
    for (const f of Array.from(files ?? [])) results.push(await addOne(f));
    setAdded(results);
    loadLibrary();
    if (xml) await propose(xml); // the proposal now sees them
  };
  const addUnder = async (f: File) => {
    const name = (renames[f.name] ?? "").trim();
    if (!name) return;
    const r = await addOne(f, name.toLowerCase().endsWith(".qxf") ? name : `${name}.qxf`);
    setAdded((rows) => rows.map((a) => (a.rename === f ? { ...r, file: f.name } : a)));
    loadLibrary();
  };
  /** After « Remplacer »: the row says what was written, where the old version went, and who else got it. */
  const replaced = (f: File, r: AddedDefinition) => {
    const parts = [
      `${addedDetail(r)} (${r.file})`,
      r.previous ? t.libraryPage.replacedKept : "",
      r.sharedUnchanged ? t.libraryPage.sharedUnchanged : "",
      r.otherVenues?.length ? t.libraryPage.replacedFor.replace("{list}", () => r.otherVenues!.map((v) => `${v.name} (${v.fixtures.join(", ")})`).join(", ")) : "",
    ].filter(Boolean);
    setAdded((rows) => rows.map((a) => (a.retry === f ? { file: f.name, ok: true, detail: parts.join(" ; ") } : a)));
    setReplacing(null);
    loadLibrary();
    if (xml) void propose(xml);
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
            {definitions === null ? `… ${t.definitionsInLibrary}` : definitions === 1 ? t.libraryPage.definitionsOne : t.libraryPage.definitionsMany.replace("{n}", String(definitions))}
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
                {a.ok ? "✔" : "✖"} {a.file}{t.colon} {a.detail}
                {a.retry && (
                  <button type="button" onClick={() => setReplacing(a.retry!)}>
                    {t.replaceDefinition}
                  </button>
                )}
                {a.rename && (
                  <span className="add-under">
                    <input
                      aria-label={`${t.libraryPage.addUnder} (${a.file})`}
                      placeholder={a.file.replace(/\.qxf$/i, "-2.qxf")}
                      value={renames[a.file] ?? ""}
                      onChange={(e) => setRenames({ ...renames, [a.file]: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && void addUnder(a.rename!)}
                    />
                    <button type="button" disabled={!(renames[a.file] ?? "").trim()} onClick={() => void addUnder(a.rename!)}>
                      {t.libraryPage.addIt}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {replacing && <ReplaceDialog file={replacing} onClose={() => setReplacing(null)} onDone={(r) => replaced(replacing, r)} />}

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
            <input type="radio" name="target" checked={target === "open"} onChange={() => setTarget("open")} /> {t.intoOpenShow} {quoted(t, openShow)}
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
                                {t.keptByHand}{t.colon} {m.kept.join(", ")}
                              </small>
                            )}{" "}
                            {m.toCheck.length > 0 && (
                              <small className="warn">
                                {t.toCheck}{t.colon} {m.toCheck.join(", ")}
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
                  {f.label || f.mapping}{t.colon} {f.reason}
                </li>
              ))}
              {selftest.untested.map((u) => (
                <li key={u.mapping}>
                  {u.label || u.mapping}{t.colon} {u.reason}
                </li>
              ))}
              {selftest.exclusivity
                .filter((e) => !e.ok)
                .map((e) => (
                  <li key={e.group}>
                    {e.group}{t.colon} {e.detail}
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

/**
 * « Remplacer » (T20b review 3): the plan first (fixture.definition.add dry run) — the file it takes the place of and
 * where, the old version going to the Library's trash, this venue's fixtures and the other venues concerned, modes they
 * lose or that change —, then a yes, « Le faire quand même » when modes in use change.
 */
function ReplaceDialog({ file, onClose, onDone }: { file: File; onClose: () => void; onDone: (r: AddedDefinition) => void }): ReactElement {
  const t = useT();
  const l = t.libraryPage;
  const [plan, setPlan] = useState<ReplacePlan | null>(null);
  const [force, setForce] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void fileBase64(file).then((base64) => cmd<ReplacePlan>("fixture.definition.add", { name: file.name, base64, replace: true, dryRun: true }).then(setPlan, (e: Error) => setError(e.message)));
  }, [file]);
  const go = () =>
    void fileBase64(file)
      .then((base64) => cmd<AddedDefinition>("fixture.definition.add", { name: file.name, base64, replace: true, force }))
      .then(onDone, (e: Error) => setError(e.message));
  const title = l.importReplaceTitle.replace("{file}", file.name);
  const folder = plan?.folder === "venue" ? l.folderVenue : l.folderShared;
  return (
    <Modal label={title} className="narrow library-dialog" onClose={onClose}>
      <h3>{title}</h3>
      {!plan && !error && <p role="status">{t.loading}</p>}
      {plan && (
        <>
          <p>{l.importReplaceInto.replace("{file}", plan.target).replace("{folder}", folder)}</p>
          {plan.replaced && <p className="hint">{l.importOldToTrash}</p>}
          {plan.sharedUnchanged && <p className="hint">{l.sharedUnchanged}</p>}
          {(plan.usedBy ?? []).length > 0 && <p>{l.importChangesHere.replace("{list}", plan.usedBy!.map((u) => u.name).join(", "))}</p>}
          {(plan.otherVenues ?? []).length > 0 && <p className="warn">{l.importChangesElsewhere.replace("{list}", plan.otherVenues!.map((v) => `${v.name} (${v.fixtures.join(", ")})`).join(", "))}</p>}
          {(plan.lostModes ?? []).length > 0 && <p className="warn">{l.importLost.replace("{list}", plan.lostModes!.join(", "))}</p>}
          {(plan.changedModes ?? []).length > 0 && <p className="warn">{l.importChanged.replace("{list}", plan.changedModes!.join(", "))}</p>}
          {plan.refused && (
            <label className="inline">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {l.forceDelete}
            </label>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="primary" disabled={!plan || (plan.refused && !force)} onClick={go}>
          {l.importReplaceIt}
        </button>
      </div>
    </Modal>
  );
}

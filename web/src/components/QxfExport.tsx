import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { downloadDefinition, type DefinitionExport } from "../api";
import { useT } from "../i18n-context";
import { isGenericDimmer } from "../../../src/plugins/light/venue/names";

/** Whether a model has a .qxf file to export: QLC+'s built-in generic dimmer has none (the server's own rule). */
export const hasQxfFile = (manufacturer: string | undefined, model: string | undefined): boolean => !!model && !isGenericDimmer(manufacturer ?? "", model);

/**
 * « Exporter le .qxf »: downloads a library definition as a QLC+ file (fixture.definition.export), the library's file
 * as it is, or with this venue's corrections where QLC+ has a place for them (« avec les corrections de ce lieu »:
 * the model's, or the fixture's over its model's). After a download, says what was written and what could not be,
 * in a region that stays in the page (role=status) and is bounded: a long report scrolls inside it, and is brought
 * into view of the menu that holds it. Used by the library (Lieu page) and by a patched fixture's menu.
 */
export function QxfExport({ target }: { target: { fixture: string } | { manufacturer: string; model: string } }): ReactElement {
  const t = useT();
  const id = useId();
  const [corrections, setCorrections] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<(DefinitionExport & { asked: boolean }) | null>(null);
  const [error, setError] = useState("");
  const report = useRef<HTMLDivElement>(null);
  const go = () => {
    setBusy(true);
    setError("");
    setDone(null);
    const asked = corrections;
    downloadDefinition(target, asked)
      .then(
        (r) => setDone({ ...r, asked }),
        (e: Error) => setError(e.message),
      )
      .finally(() => setBusy(false));
  };
  // the report (or the error) shown whole: the menu it is in scrolls to it when it does not fit
  useEffect(() => {
    if (done || error) (error ? report.current?.nextElementSibling : report.current)?.scrollIntoView({ block: "nearest" });
  }, [done, error]);
  return (
    <div className="qxf-export" data-testid="qxf-export">
      <div className="row">
        <label className="inline" htmlFor={`${id}-corr`}>
          <input id={`${id}-corr`} type="checkbox" checked={corrections} onChange={(e) => setCorrections(e.target.checked)} /> {t.qxfWithCorrections}
        </label>
        <button type="button" disabled={busy} onClick={go} aria-describedby={`${id}-help`}>
          <span aria-hidden="true">⤓</span> {t.qxfExport}
        </button>
      </div>
      <small id={`${id}-help`} className="hint">
        {t.qxfExportHelp}
      </small>
      {/* focusable once filled: a long report scrolls inside, from the keyboard too */}
      <div ref={report} className="hint qxf-report" role="status" aria-label={t.qxfReport} tabIndex={done ? 0 : undefined}>
        {done && (
          <>
            <span>{t.qxfExported.replace("{file}", () => done.file)}</span>
            {done.asked && !done.corrected && <span> {t.qxfNothingToWrite}</span>}
            {done.applied.length > 0 && (
              <>
                <span> {t.qxfWritten}</span>
                <ul>
                  {done.applied.map((n, k) => (
                    <li key={k}>{n.message}</li>
                  ))}
                </ul>
              </>
            )}
            {done.notExported.length > 0 && (
              <>
                <span className="warn"> {t.qxfNotExported}</span>
                <ul>
                  {done.notExported.map((n, k) => (
                    <li key={k}>{n.message}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

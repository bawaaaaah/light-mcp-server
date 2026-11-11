import { useEffect, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";

interface HeadRow {
  head: number;
  accent: boolean;
  channels: { name: string }[];
}

/** What venue.fixture.heads answers. */
interface Heads {
  deduced: boolean;
  /** As this fixture resolves (its model's correction, then its own). */
  heads: HeadRow[];
  follow: boolean;
  escaped: { name: string }[];
  overrides: { model?: unknown; fixture?: unknown };
  /** As the model's correction alone gives them, and how many patched fixtures of that model it reaches. */
  model: { heads: HeadRow[]; follow: boolean; fixtures: number };
}

/**
 * The fixture menu's « Heads and halo » entry: a fixture's colour heads (declared, or deduced from its channel
 * names) and which of them is an accent (a halo: it follows the look but is no full colour of the fixture), set for
 * its model or this fixture only (venue.fixture.heads.set / .clear). « This model » shows and edits the model's
 * correction, « this fixture only » what this fixture gets. Folded until asked for.
 */
export function FixtureHeads({ fixture, onSaved }: { fixture: string; onSaved: () => void }): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [heads, setHeads] = useState<Heads | null>(null);
  const [scope, setScope] = useState<"model" | "fixture" | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setError("");
    void cmd<Heads>("venue.fixture.heads", { fixture }).then(
      (h) => {
        setHeads(h);
        // a fixture with its own correction: the model's would change nothing visible here
        setScope((s) => s ?? (h.overrides.fixture !== undefined ? "fixture" : "model"));
      },
      (e: Error) => setError(e.message),
    );
  }, [open, fixture]);
  const save = (name: string, args: Record<string, unknown>) => {
    setError("");
    void cmd<Heads>(name, { fixture, scope, ...args }).then(
      (h) => {
        setHeads(h);
        onSaved();
      },
      (e: Error) => setError(e.message),
    );
  };
  const shown = heads && (scope === "model" ? { rows: heads.model.heads, follow: heads.model.follow } : { rows: heads.heads, follow: heads.follow });
  /** The accent is said by channel names: those of every head marked, with `head` switched. */
  const toggle = (head: number) => {
    const accent = shown!.rows.filter((h) => (h.head === head ? !h.accent : h.accent)).flatMap((h) => h.channels.map((c) => c.name));
    save("venue.fixture.heads.set", { accent });
  };
  const whole = heads !== null && heads.heads.length === 1 && heads.heads[0]!.head < 0;
  const corrected = heads && (scope === "model" ? heads.overrides.model : heads.overrides.fixture) !== undefined;

  return (
    <div className="field">
      <button className="ghost" aria-expanded={open} title={t.headsHelp} onClick={() => setOpen(!open)}>
        {t.headsMenu}
      </button>
      {open && !heads && !error && (
        <small className="hint" role="status">
          {t.loading}
        </small>
      )}
      {open && heads && shown && (
        <>
          {whole ? (
            <small className="hint">{t.headsWhole}</small>
          ) : (
            <>
              <div className="swatches" role="radiogroup" aria-label={t.headsScope}>
                {(["model", "fixture"] as const).map((s) => (
                  <button key={s} className={`ghost${scope === s ? " on" : ""}`} role="radio" aria-checked={scope === s} onClick={() => setScope(s)}>
                    {s === "model" ? t.headsScopeModel : t.headsScopeFixture}
                  </button>
                ))}
              </div>
              <small className="hint">
                {scope === "model" ? t.headsModelCount.replace("{n}", String(heads.model.fixtures)) : ""}
                {heads.overrides.fixture !== undefined ? ` ${t.headsCorrectedFixture}` : heads.overrides.model !== undefined ? ` ${t.headsCorrectedModel}` : ""}
              </small>
              {shown.rows.map((h) => {
                const names = h.channels.map((c) => c.name).join(", ");
                return (
                  // keyed by the head's number, which the accent never moves: the focus stays on the head toggled
                  <div key={h.head} className="invert-row">
                    <span>
                      {h.accent ? t.headAccent : `${t.headZone} ${h.head + 1}`}
                      <br />
                      <small className="hint">{names}</small>
                    </span>
                    <button className={`ghost${h.accent ? " on" : ""}`} aria-pressed={h.accent} aria-label={`${t.headAccentToggle} · ${names}`} onClick={() => toggle(h.head)}>
                      {h.accent ? "◉" : "○"} {t.headAccentToggle}
                    </button>
                  </div>
                );
              })}
              {shown.rows.some((h) => h.accent) && (
                <div className="invert-row">
                  <span>{t.headsFollow}</span>
                  <button className={`ghost${shown.follow ? " on" : ""}`} aria-pressed={shown.follow} aria-label={t.headsFollow} onClick={() => save("venue.fixture.heads.set", { follow: !shown.follow })}>
                    {shown.follow ? "◉" : "○"}
                  </button>
                </div>
              )}
              {corrected && (
                <button className="ghost" onClick={() => save("venue.fixture.heads.clear", {})}>
                  {scope === "model" ? t.headsResetModel : t.headsResetFixture}
                </button>
              )}
              {heads.deduced && <small className="hint">{t.headsDeduced}</small>}
            </>
          )}
          {heads.escaped.length > 0 && <small className="warn">{t.headsEscaped + heads.escaped.map((c) => c.name).join(", ")}</small>}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

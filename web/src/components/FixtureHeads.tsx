import { useEffect, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";

/** What venue.fixture.heads answers. */
interface Heads {
  deduced: boolean;
  heads: { head: number; accent: boolean; channels: { name: string }[] }[];
  follow: boolean;
  escaped: { name: string }[];
  overrides: { model?: unknown; fixture?: unknown };
}

/**
 * The fixture menu's « Heads and halo » entry: a fixture's colour heads (declared, or deduced from its channel
 * names) and which of them is an accent (a halo: it follows the look but is no full colour of the fixture), set for
 * its model or this fixture only (venue.fixture.heads.set / .clear). Folded until asked for.
 */
export function FixtureHeads({ fixture, onSaved }: { fixture: string; onSaved: () => void }): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [heads, setHeads] = useState<Heads | null>(null);
  const [scope, setScope] = useState<"model" | "fixture">("model");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    void cmd<Heads>("venue.fixture.heads", { fixture }).then(setHeads, (e: Error) => setError(e.message));
  }, [open, fixture]);
  const save = (name: string, args: Record<string, unknown>) => {
    setError("");
    void cmd<Heads>(name, { fixture, scope, ...args }).then((h) => (setHeads(h), onSaved()), (e: Error) => setError(e.message));
  };
  /** The accent is said by channel names: those of every head marked, with `head` switched. */
  const toggle = (head: number) => {
    const accent = heads!.heads.filter((h) => (h.head === head ? !h.accent : h.accent)).flatMap((h) => h.channels.map((c) => c.name));
    save("venue.fixture.heads.set", { accent });
  };

  return (
    <div className="field">
      <button className="ghost" aria-expanded={open} title={t.headsHelp} onClick={() => setOpen(!open)}>
        {t.headsMenu}
      </button>
      {open && heads && (
        <>
          <div className="swatches" role="radiogroup" aria-label={t.headsScope}>
            {(["model", "fixture"] as const).map((s) => (
              <button key={s} className={`ghost${scope === s ? " on" : ""}`} role="radio" aria-checked={scope === s} onClick={() => setScope(s)}>
                {s === "model" ? t.headsScopeModel : t.headsScopeFixture}
              </button>
            ))}
          </div>
          {heads.heads.length === 1 && heads.heads[0]!.head < 0 ? (
            <small className="hint">{t.headsWhole}</small>
          ) : (
            heads.heads.map((h) => {
              const label = h.accent ? t.headAccent : `${t.headZone} ${heads.heads.filter((x) => !x.accent && x.head <= h.head).length}`;
              return (
                <div key={h.head} className="invert-row" title={h.channels.map((c) => c.name).join(", ")}>
                  <span>{label}</span>
                  <button className={`ghost${h.accent ? " on" : ""}`} aria-pressed={h.accent} aria-label={`${t.headAccentToggle} · ${h.channels.map((c) => c.name).join(", ")}`} onClick={() => toggle(h.head)}>
                    {h.accent ? "◉" : "○"} {t.headAccentToggle}
                  </button>
                </div>
              );
            })
          )}
          {heads.heads.some((h) => h.accent) && (
            <div className="invert-row">
              <span>{t.headsFollow}</span>
              <button className={`ghost${heads.follow ? " on" : ""}`} aria-pressed={heads.follow} aria-label={t.headsFollow} onClick={() => save("venue.fixture.heads.set", { follow: !heads.follow })}>
                {heads.follow ? "◉" : "○"}
              </button>
            </div>
          )}
          {(scope === "model" ? heads.overrides.model : heads.overrides.fixture) !== undefined && (
            <button className="ghost" onClick={() => save("venue.fixture.heads.clear", {})}>
              {t.headsReset}
            </button>
          )}
          {heads.deduced && <small className="hint">{t.headsDeduced}</small>}
          {heads.escaped.length > 0 && <p className="error">{t.headsEscaped + heads.escaped.map((c) => c.name).join(", ")}</p>}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

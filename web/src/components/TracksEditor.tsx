import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";

type Kind = "dimmer" | "colour" | "position" | "wheel" | "other";
/** A fixture's fadeable tracks, as venue.tracks.get gives them (T5). */
interface TracksInfo {
  enabled: boolean;
  applies: "fixture" | "model" | "none";
  channels: { name: string; kind: Kind; fade: boolean }[];
  own: string[] | null;
  /** `ids`: the patched fixtures of its model; `enabled`: those of them whose tracks are on. */
  model: { fade: string[] | null; ids: string[]; enabled: string[] };
}
type Scope = "model" | "fixture";
/** The groups of the editor, in this order; the wheel sits with the colour. */
const GROUPS: { key: "light" | "colour" | "position" | "other"; kinds: Kind[] }[] = [
  { key: "light", kinds: ["dimmer"] },
  { key: "colour", kinds: ["colour", "wheel"] },
  { key: "position", kinds: ["position"] },
  { key: "other", kinds: ["other"] },
];

/**
 * « Transitions… » in a fixture's menu (docs/specs/engine-effects-timing.md, « Pistes fondables », T5): the switch of
 * its tracks (on the fixture only), and per channel whether it follows the transitions, for its model or for this
 * fixture only. Nothing is ticked at first; the shortcuts tick (or untick) a whole kind. Pan and tilt are saved for the motion
 * layer, which does not exist yet: the editor says so. The colour wheel has no box: it follows its own setting.
 */
export function TracksEntry({ fixtureId, onSaved }: { fixtureId: string; onSaved: () => void }): ReactElement | null {
  const t = useT();
  const [info, setInfo] = useState<TracksInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("model");
  const [error, setError] = useState("");
  // puts go one after the other (two quick ticks never overwrite each other)
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const scopeButtons = useRef<Record<Scope, HTMLButtonElement | null>>({ model: null, fixture: null });
  // the list a tick just asked for, shown (and built on by the next tick) until every put has come back
  const [asked, setAsked] = useState<{ scope: Scope; list: string[] } | null>(null);
  const inflight = useRef(0);
  const load = useCallback(
    (first = false) =>
      cmd<TracksInfo>("venue.tracks.get", { fixture: fixtureId }).then(
        (x) => {
          setInfo(x);
          if (first) setScope(x.applies === "fixture" ? "fixture" : "model");
        },
        () => setInfo(null),
      ),
    [fixtureId],
  );
  useEffect(() => {
    void load(true);
  }, [load]);
  if (!info) return null;
  const run = (name: string, args: object) => {
    setError("");
    inflight.current += 1;
    chain.current = chain.current
      .then(() => cmd(name, args))
      .then(() => load().then(onSaved))
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        inflight.current -= 1;
        if (inflight.current === 0) setAsked(null);
      });
  };
  // what this scope holds now; a fixture without its own list starts from its model's
  const list = asked?.scope === scope ? asked.list : scope === "fixture" ? (info.own ?? info.model.fade ?? []) : (info.model.fade ?? []);
  const ticked = new Set(list);
  const put = (fade: string[]) => {
    setAsked({ scope, list: fade });
    run("venue.tracks.put", { fixtures: [fixtureId], scope, fade });
  };
  const tick = (name: string, on: boolean) => put(on ? [...list.filter((n) => n !== name), name] : list.filter((n) => n !== name));
  const namesOf = (kinds: Kind[]) => info.channels.filter((c) => kinds.includes(c.kind) && c.kind !== "wheel").map((c) => c.name);
  const allTicked = (kinds: Kind[]) => namesOf(kinds).every((n) => ticked.has(n));
  /** Ticks every channel of a kind, or unticks them all when they all are. */
  const tickKind = (kinds: Kind[]) => {
    const names = namesOf(kinds);
    put(allTicked(kinds) ? list.filter((n) => !names.includes(n)) : [...new Set([...list, ...names])]);
  };
  const moveScope = (e: KeyboardEvent<HTMLButtonElement>, from: Scope) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
    if (!step) return;
    e.preventDefault();
    const next: Scope = from === "model" ? "fixture" : "model";
    setScope(next);
    scopeButtons.current[next]?.focus();
  };
  const others = info.model.ids.length;
  const allOn = info.model.enabled.length === others;
  const nothing = !info.channels.some((c) => c.kind !== "wheel" && ticked.has(c.name));
  return (
    <div className="field tracks-entry">
      <button className="ghost" aria-expanded={open} title={t.tracksHelp} onClick={() => setOpen(!open)}>
        {t.tracksMenu}
        {info.enabled ? ` · ${t.tracksOnShort}` : ""}
      </button>
      {open && (
        <div className="tracks-editor" role="group" aria-label={t.tracksMenu}>
          <div className="invert-row">
            <span>{t.tracksEnabled}</span>
            <button className={`ghost${info.enabled ? " on" : ""}`} aria-pressed={info.enabled} aria-label={t.tracksEnabled} onClick={() => run("venue.tracks.put", { fixtures: [fixtureId], enabled: !info.enabled })}>
              {info.enabled ? "◉" : "○"}
            </button>
          </div>
          {!info.enabled && <small className="hint">{t.tracksOffHint}</small>}
          {others > 1 && (
            <button className="ghost" onClick={() => run("venue.tracks.put", { fixtures: info.model.ids, enabled: !allOn })}>
              {(allOn ? t.tracksDisableModel : t.tracksEnableModel).replace("{n}", String(others))}
            </button>
          )}
          <div className="swatches" role="radiogroup" aria-label={t.headsScope}>
            {(["model", "fixture"] as const).map((s) => (
              <button
                key={s}
                ref={(el) => void (scopeButtons.current[s] = el)}
                className={`ghost${scope === s ? " on" : ""}`}
                role="radio"
                aria-checked={scope === s}
                tabIndex={scope === s ? 0 : -1}
                onKeyDown={(e) => moveScope(e, s)}
                onClick={() => setScope(s)}
              >
                {s === "model" ? t.headsScopeModel : t.headsScopeFixture}
              </button>
            ))}
          </div>
          <small className="hint">
            {t.tracksApplies}
            {t.tracksAppliesNames[info.applies]}
          </small>
          {scope === "fixture" && !info.own && <small className="hint">{t.tracksScopeCopies}</small>}
          {scope === "model" && others > 1 && <small className="hint">{t.headsModelCount.replace("{n}", String(others))}</small>}
          {scope === "model" && info.own && <small className="hint">{t.tracksOwnList}</small>}
          {info.own && (
            <button
              className="ghost"
              onClick={() => {
                // the button goes once the list is back to the model's: the focus waits on the scope in force
                scopeButtons.current[scope]?.focus();
                run("venue.tracks.clear", { fixture: fixtureId });
              }}
            >
              {t.tracksBackToModel}
            </button>
          )}
          <div className={`tracks-groups${info.enabled ? "" : " off"}`}>
            {GROUPS.map(({ key, kinds }) => {
              const channels = info.channels.filter((c) => kinds.includes(c.kind));
              if (!channels.length) return null;
              const tickable = channels.some((c) => c.kind !== "wheel");
              return (
                <fieldset key={key}>
                  <legend>{t.tracksGroups[key]}</legend>
                  {channels.map((c) =>
                    c.kind === "wheel" ? (
                      <small key={c.name} className="hint">
                        {c.name} : {t.tracksWheel}
                      </small>
                    ) : (
                      <label key={c.name} className="tracks-channel">
                        <input type="checkbox" checked={ticked.has(c.name)} onChange={(e) => tick(c.name, e.target.checked)} />
                        <span>{c.name}</span>
                      </label>
                    ),
                  )}
                  {key === "position" && <small className="hint">{t.tracksPositionHint}</small>}
                  {key !== "other" && tickable && (
                    <button className="ghost" onClick={() => tickKind(kinds)}>
                      {allTicked(kinds) ? t.tracksUntickKind[key] : t.tracksTickKind[key]}
                    </button>
                  )}
                </fieldset>
              );
            })}
          </div>
          <small className="hint" role="status">
            {nothing ? t.tracksNothing : t.tracksSome}
          </small>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

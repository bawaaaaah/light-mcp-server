import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { isHex, SWATCHES } from "../color";
import { useFloatingMenu } from "./menu";
import { FixtureHeads } from "./FixtureHeads";
import { WheelEntry } from "./WheelEditor";

export interface MarkedFixture {
  id: string;
  name: string;
  universe: number;
  address: number;
  /** Pan or tilt channels in its definition (venue.fixture.list): the invert switches live on these only. */
  movable?: boolean;
  color?: string;
  /** A moving head's stored orientation; only the inversions are shown here. */
  orientation?: { invertPan?: boolean; invertTilt?: boolean };
}

/** Strips what venue.fixture.list adds to a patched fixture (absence, movable, facing), to write the rest back whole. */
function patched(listed: Record<string, unknown>): Record<string, unknown> {
  const { absent: _absent, movable: _movable, facing: _facing, ...stored } = listed;
  return stored;
}

/** The controls Tab stops at, in order (a radio group's unchecked radios are not stops). */
function tabStops(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
}

/**
 * Why a new place in the patch cannot be taken, in words; empty when it can. `universes`: how many the
 * output has (a fixture already beyond them may stay there); `channels`: the fixture's footprint.
 */
export function placeProblem(universe: string, address: string, current: { universe: number }, t: ReturnType<typeof useT>, universes?: number, channels?: number): string {
  return placeIssue(universe, address, current, t, universes, channels)?.message ?? "";
}

/** The same check, with the field at fault: the universe, or the address (also when the fixture would end past 512). */
export function placeIssue(universe: string, address: string, current: { universe: number }, t: ReturnType<typeof useT>, universes?: number, channels?: number): { field: "universe" | "address"; message: string } | undefined {
  const u = Number(universe);
  const a = Number(address);
  // the output's universes unknown: the sentence cannot give the bound, the server still checks
  if (universe.trim() === "" || !Number.isInteger(u) || u < 1 || (universes !== undefined && u > universes && u !== current.universe)) return { field: "universe", message: universes === undefined ? t.fixtureUniverseBadNoMax : t.fixtureUniverseBad.replace("{max}", String(universes)) };
  if (address.trim() === "" || !Number.isInteger(a) || a < 1 || a > 512) return { field: "address", message: t.fixtureAddressBad };
  if (channels !== undefined && a + channels - 1 > 512) return { field: "address", message: t.fixturePastEnd.replace("{n}", String(channels)).replace("{end}", String(a + channels - 1)) };
  return undefined;
}

/**
 * Right-click (or a long press, or Shift+F10 on a focused row) on a patched fixture: its name, a colour
 * to tell it at a glance (venue.fixture.mark), the pan/tilt inversions of a moving head
 * (venue.fixture.orient), its place in the patch (universe and address, checked here first, then
 * written whole with venue.fixture.put after re-reading it), and, apart, its deletion (`onDelete`,
 * the page's confirmation). Every change is saved at once; the colour is never sent to the fixture.
 * `overlaps`: the sentences naming the other fixture sharing its DMX channels. `onGone`: the fixture
 * was deleted meanwhile. Focus stays inside while it is open and goes back where it was on close.
 */
export function FixtureMenu({
  fixture,
  overlaps,
  at,
  universes,
  channels,
  onSaved,
  onDelete,
  onGone,
  onClose,
}: {
  fixture: MarkedFixture;
  overlaps: string[];
  at: { x: number; y: number };
  /** How many universes the output has (lightState); unknown: not checked here, the server still is. */
  universes?: number;
  /** How many DMX channels the fixture takes (its mode); unknown: its end is not checked. */
  channels?: number;
  onSaved: () => void;
  onDelete: () => Promise<boolean>;
  onGone: () => void;
  onClose: () => void;
}): ReactElement {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  // where the focus was (the row, the plan's fixture): it goes back there when the menu closes
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const back = opener.current;
    return () => {
      // StrictMode runs this cleanup between two mounts in dev: the menu is back by the time the microtask runs, then focus stays
      queueMicrotask(() => {
        // eslint-disable-next-line react-hooks/exhaustive-deps -- read on purpose after the cleanup: is the menu still (or again) in the page?
        if (!box.current?.isConnected && back?.isConnected) back.focus();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once; `box` is a stable ref
  }, []);
  const [name, setName] = useState(fixture.name);
  const [color, setColor] = useState(fixture.color);
  const o = fixture.orientation ?? {}; // a fixture that was never oriented has no orientation object
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [universe, setUniverse] = useState(String(fixture.universe));
  const [address, setAddress] = useState(String(fixture.address));
  const moved = Number(universe) !== fixture.universe || Number(address) !== fixture.address;
  const issue = placeIssue(universe, address, fixture, t, universes, channels);
  const problem = issue?.message ?? "";
  const mark = (args: { name?: string; color?: string | null }) => {
    setError("");
    void cmd("venue.fixture.mark", { id: fixture.id, ...args }).then(onSaved, (e: Error) => setError(e.message));
  };
  const invert = (axis: "invertPan" | "invertTilt", next: boolean) => {
    setError("");
    void cmd("venue.fixture.orient", { id: fixture.id, [axis]: next }).then(onSaved, (e: Error) => setError(e.message));
  };
  /** Re-reads the whole fixture (the list may have moved on since the menu opened), then writes it back with the new place. */
  const move = async () => {
    if (!moved || problem) return;
    setError("");
    setWarning("");
    try {
      const fresh = (await cmd<Record<string, unknown>[]>("venue.fixture.list")).find((x) => x.id === fixture.id);
      if (!fresh) return onGone();
      const r = await cmd<{ warning?: string }>("venue.fixture.put", { fixture: { ...patched(fresh), universe: Number(universe), address: Number(address) } });
      setWarning(r.warning ?? "");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = () => {
    setError("");
    onDelete().then(
      (done) => done && onClose(),
      (e: Error) => setError(e.message),
    );
  };
  const rename = () => {
    const next = name.trim();
    if (next && next !== fixture.name) mark({ name: next });
  };
  const paint = (hex: string | null) => {
    setColor(hex ?? undefined);
    mark({ color: hex });
  };
  /** The colour radios, « none » first: one Tab stop (the checked one), the arrows move and choose. */
  const choices: (string | null)[] = [null, ...SWATCHES.map(([, hex]) => hex)];
  const checked = choices.indexOf(color ?? null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const onSwatchKey = (e: ReactKeyboardEvent, i: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const to = step !== undefined ? (i + step + choices.length) % choices.length : e.key === "Home" ? 0 : e.key === "End" ? choices.length - 1 : undefined;
    if (to === undefined) return;
    e.preventDefault();
    radios.current[to]?.focus();
    paint(choices[to]!);
  };
  /** Tab and Shift+Tab go round inside the menu instead of leaving it for the page behind. */
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const stops = tabStops(box.current);
    if (!stops.length) return;
    const [first, last] = [stops[0]!, stops[stops.length - 1]!];
    const active = document.activeElement;
    if (!active || active === box.current || !box.current.contains(active)) {
      e.preventDefault(); // the box itself (a click on its background) or something outside it: back to a stop
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const onPlaceKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") void move();
  };
  return (
    <div ref={box} className="widget-menu" role="dialog" aria-modal="true" tabIndex={-1} aria-label={t.fixtureSettings} style={style} onContextMenu={(e) => e.preventDefault()} onKeyDown={trap}>
      <h3>
        {fixture.name} · U{fixture.universe}.{fixture.address}
      </h3>
      <label className="field">
        <span>{t.name}</span>
        <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && (rename(), onClose())} />
      </label>
      <div className="field">
        <span id={`fixture-color-${fixture.id}`}>{t.fixtureColor}</span>
        <div className="swatches" role="radiogroup" aria-labelledby={`fixture-color-${fixture.id}`}>
          {choices.map((hex, i) => {
            const label = hex === null ? t.noColor : t.swatchNames[SWATCHES[i - 1]![0] as keyof typeof t.swatchNames];
            return (
              <button
                key={hex ?? "none"}
                ref={(el) => void (radios.current[i] = el)}
                className={`swatch${hex === null ? " none" : ""}${i === checked ? " chosen" : ""}`}
                role="radio"
                aria-checked={i === checked}
                tabIndex={i === (checked < 0 ? 0 : checked) ? 0 : -1}
                title={label}
                aria-label={label}
                style={hex === null ? undefined : { background: hex }}
                onClick={() => paint(hex)}
                onKeyDown={(e) => onSwatchKey(e, i)}
              />
            );
          })}
          <input type="color" aria-label={t.customColor} title={t.customColor} value={isHex(color) ? color : "#ffffff"} onChange={(e) => paint(e.target.value)} />
        </div>
        <small className="hint">{t.fixtureColorHelp}</small>
      </div>
      {/* The app's switches are ghost buttons with aria-pressed (the Live's toggles): a row of
          « label left, switch right » — the menu's .field grid would strand a native checkbox on
          its own line. Inversions only make sense on a fixture that carries pan or tilt. */}
      {fixture.movable && (
        <>
          <div className="invert-row" title={t.invertAxisHelp}>
            <span>{t.invertPanLabel}</span>
            <button
              className={`ghost${o.invertPan ? " on" : ""}`}
              aria-pressed={Boolean(o.invertPan)}
              aria-label={t.invertPanLabel}
              title={t.invertAxisHelp}
              onClick={() => invert("invertPan", !o.invertPan)}
            >
              {o.invertPan ? "◉" : "○"}
            </button>
          </div>
          <div className="invert-row" title={t.invertAxisHelp}>
            <span>{t.invertTiltLabel}</span>
            <button
              className={`ghost${o.invertTilt ? " on" : ""}`}
              aria-pressed={Boolean(o.invertTilt)}
              aria-label={t.invertTiltLabel}
              title={t.invertAxisHelp}
              onClick={() => invert("invertTilt", !o.invertTilt)}
            >
              {o.invertTilt ? "◉" : "○"}
            </button>
          </div>
          <small className="hint">{t.invertAxisHelp}</small>
        </>
      )}
      <FixtureHeads fixture={fixture.id} onSaved={onSaved} />
      <WheelEntry fixtureId={fixture.id} onSaved={onSaved} />
      <fieldset className="fixture-place">
        <legend>{t.fixtureMove}</legend>
        <div className="row">
          <label>
            <span>{t.universe}</span>
            <input type="number" min={1} max={universes} step={1} value={universe} aria-invalid={issue?.field === "universe"} onChange={(e) => setUniverse(e.target.value)} onKeyDown={onPlaceKey} />
          </label>
          <label>
            <span>{t.address}</span>
            <input type="number" min={1} max={512} step={1} value={address} aria-invalid={issue?.field === "address"} onChange={(e) => setAddress(e.target.value)} onKeyDown={onPlaceKey} />
          </label>
          <button disabled={!moved || Boolean(problem)} aria-describedby={problem ? `fixture-place-${fixture.id}` : undefined} onClick={() => void move()}>
            {t.fixtureMoveDo}
          </button>
        </div>
        {problem && (
          <small className="warn" id={`fixture-place-${fixture.id}`}>
            {problem}
          </small>
        )}
        {warning && <small className="warn">{warning}</small>}
      </fieldset>
      {overlaps.length > 0 && (
        <div role="alert" className="overlap-alert">
          <strong>⚠ {t.fixtureOverlapTitle}</strong>
          <ul>
            {overlaps.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="menu-danger">
        <button className="danger" onClick={remove}>
          {t.delete}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

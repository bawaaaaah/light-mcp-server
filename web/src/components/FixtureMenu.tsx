import { useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { isHex, SWATCHES } from "../color";
import { useFloatingMenu } from "./menu";
import { FixtureHeads } from "./FixtureHeads";

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

/**
 * Right-click (or a long press) on a patched fixture: its name, a colour to tell it at a glance
 * (venue.fixture.mark), the pan/tilt inversions of a moving head (venue.fixture.orient), its place in
 * the patch (universe and address, written whole with venue.fixture.put after re-reading it), and its
 * deletion (`onDelete`, the page's confirmation). Every change is saved at once; the colour is never
 * sent to the fixture. `overlaps`: the sentences naming the other fixture sharing its DMX channels.
 */
export function FixtureMenu({ fixture, overlaps, at, onSaved, onDelete, onClose }: { fixture: MarkedFixture; overlaps: string[]; at: { x: number; y: number }; onSaved: () => void; onDelete: () => Promise<boolean>; onClose: () => void }): ReactElement {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  const [name, setName] = useState(fixture.name);
  const [color, setColor] = useState(fixture.color);
  const o = fixture.orientation ?? {}; // a fixture that was never oriented has no orientation object
  const [error, setError] = useState("");
  const [universe, setUniverse] = useState(String(fixture.universe));
  const [address, setAddress] = useState(String(fixture.address));
  const moved = Number(universe) !== fixture.universe || Number(address) !== fixture.address;
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
    setError("");
    try {
      const fresh = (await cmd<Record<string, unknown>[]>("venue.fixture.list")).find((x) => x.id === fixture.id);
      if (!fresh) return;
      await cmd("venue.fixture.put", { fixture: { ...patched(fresh), universe: Number(universe), address: Number(address) } });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const rename = () => {
    const next = name.trim();
    if (next && next !== fixture.name) mark({ name: next });
  };
  const paint = (hex: string | null) => {
    setColor(hex ?? undefined);
    mark({ color: hex });
  };
  return (
    <div ref={box} className="widget-menu" role="dialog" aria-label={t.fixtureSettings} style={style} onContextMenu={(e) => e.preventDefault()}>
      <h3>
        {fixture.name} · U{fixture.universe}.{fixture.address}
      </h3>
      <label className="field">
        <span>{t.name}</span>
        <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && (rename(), onClose())} />
      </label>
      <div className="field">
        <span>{t.fixtureColor}</span>
        <div className="swatches" role="radiogroup" aria-label={t.fixtureColor}>
          <button className={`swatch none ${!color ? "chosen" : ""}`} role="radio" aria-checked={!color} title={t.noColor} aria-label={t.noColor} onClick={() => paint(null)} />
          {SWATCHES.map(([swatch, hex]) => (
            <button key={hex} className={`swatch ${color === hex ? "chosen" : ""}`} role="radio" aria-checked={color === hex} title={t.swatchNames[swatch as keyof typeof t.swatchNames]} aria-label={t.swatchNames[swatch as keyof typeof t.swatchNames]} style={{ background: hex }} onClick={() => paint(hex)} />
          ))}
          <input type="color" aria-label={t.customColor} title={t.customColor} value={isHex(color) ? color : "#ffffff"} onChange={(e) => paint(e.target.value)} />
        </div>
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
      <small className="hint">{t.fixtureColorHelp}</small>
      <div className="field">
        <span>{t.fixtureMove}</span>
        <div className="row fixture-place">
          <input type="number" min={1} aria-label={t.universe} value={universe} onChange={(e) => setUniverse(e.target.value)} />
          <input type="number" min={1} max={512} aria-label={t.address} value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === "Enter" && moved && void move()} />
          <button disabled={!moved} onClick={() => void move()}>
            {t.fixtureMoveDo}
          </button>
        </div>
      </div>
      {overlaps.length > 0 && (
        <div role="alert" className="badge conflict">
          <strong>⚠ {t.fixtureOverlapTitle}</strong>
          <ul>
            {overlaps.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <button className="danger" onClick={() => void onDelete().then((done) => done && onClose())}>
        {t.delete}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

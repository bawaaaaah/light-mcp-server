import { useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { isHex, SWATCHES } from "../color";
import { useFloatingMenu } from "./menu";

export interface MarkedFixture {
  id: string;
  name: string;
  universe: number;
  address: number;
  color?: string;
}

/**
 * Right-click (or a long press) on a patched fixture: its name and a colour to tell it at a glance
 * (venue.fixture.mark). Every change is saved at once; the colour is never sent to the fixture.
 */
export function FixtureMenu({ fixture, at, onSaved, onClose }: { fixture: MarkedFixture; at: { x: number; y: number }; onSaved: () => void; onClose: () => void }) {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  const [name, setName] = useState(fixture.name);
  const [color, setColor] = useState(fixture.color);
  const [error, setError] = useState("");
  const mark = (args: { name?: string; color?: string | null }) => {
    setError("");
    void cmd("venue.fixture.mark", { id: fixture.id, ...args }).then(onSaved, (e: Error) => setError(e.message));
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
      <small className="hint">{t.fixtureColorHelp}</small>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

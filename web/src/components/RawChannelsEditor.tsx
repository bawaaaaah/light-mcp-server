/**
 * Raw channels of a look (docs/specs/engine-effects-timing.md, « Canaux bruts »): channels outside
 * the canvas — smoke, hazer, a lamp — with a DMX value per step, stepped with the look's clock.
 * A channel is picked by name from the fixture's definition, or by number without one.
 */
import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import type { FixtureChannels } from "./FaderEditor";

export interface LookChannelsDraft {
  targets: { fixture: string; offset: number }[];
  steps: number[][];
}

export function RawChannelsEditor({ value, onChange }: { value?: LookChannelsDraft; onChange: (v: LookChannelsDraft | undefined) => void }) {
  const t = useT();
  const [all, setAll] = useState<FixtureChannels[]>([]);
  const [fixture, setFixture] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => void cmd<FixtureChannels[]>("venue.fixture.channels").then(setAll).catch(() => undefined), []);

  const picked = all.find((f) => f.id === fixture);
  const label = (c: { fixture: string; offset: number }) => {
    const f = all.find((x) => x.id === c.fixture);
    return `${f?.name ?? c.fixture} · ${f?.channels.find((x) => x.offset === c.offset)?.name ?? `${t.channel} ${c.offset + 1}`}`;
  };
  const add = () => {
    if (!fixture) return;
    const target = { fixture, offset };
    if (value?.targets.some((x) => x.fixture === fixture && x.offset === offset)) return;
    onChange(value ? { targets: [...value.targets, target], steps: value.steps.map((row) => [...row, 0]) } : { targets: [target], steps: [[255]] });
  };
  const removeTarget = (k: number) => {
    if (!value) return;
    const targets = value.targets.filter((_, i) => i !== k);
    onChange(targets.length ? { targets, steps: value.steps.map((row) => row.filter((_, i) => i !== k)) } : undefined);
  };
  const setCell = (s: number, k: number, v: number) => value && onChange({ ...value, steps: value.steps.map((row, i) => (i === s ? row.map((x, j) => (j === k ? Math.max(0, Math.min(255, Math.round(v))) : x)) : row)) });
  const addStep = () => value && onChange({ ...value, steps: [...value.steps, [...value.steps[value.steps.length - 1]!]] });
  const removeStep = (s: number) => value && value.steps.length > 1 && onChange({ ...value, steps: value.steps.filter((_, i) => i !== s) });

  return (
    <div className="raw-channels">
      <p className="hint">{t.rawChannelsHelp}</p>
      <div className="fields">
        <label className="field">
          <span>{t.fixture}</span>
          <select
            aria-label={t.fixture}
            value={fixture}
            onChange={(e) => {
              setFixture(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">—</option>
            {all.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.channel}</span>
          {picked?.channels.length ? (
            <select aria-label={t.channel} value={offset} onChange={(e) => setOffset(Number(e.target.value))}>
              {picked.channels.map((c) => (
                <option key={c.offset} value={c.offset}>
                  {c.offset + 1}. {c.name}
                </option>
              ))}
            </select>
          ) : (
            <input aria-label={t.channel} type="number" min={1} max={512} value={offset + 1} onChange={(e) => setOffset(Math.max(0, Number(e.target.value) - 1))} />
          )}
        </label>
        <button onClick={add} disabled={!fixture}>
          + {t.addChannel}
        </button>
      </div>
      {value && (
        <table className="raw-steps">
          <thead>
            <tr>
              <th>{t.step}</th>
              {value.targets.map((c, k) => (
                <th key={`${c.fixture}:${c.offset}`}>
                  {label(c)}{" "}
                  <button className="ghost" aria-label={`${t.delete} ${label(c)}`} onClick={() => removeTarget(k)}>
                    ×
                  </button>
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {value.steps.map((row, s) => (
              <tr key={s}>
                <td>{s + 1}</td>
                {row.map((v, k) => (
                  <td key={k}>
                    <input aria-label={`${t.step} ${s + 1} · ${label(value.targets[k]!)}`} type="number" min={0} max={255} value={v} onChange={(e) => setCell(s, k, Number(e.target.value))} />
                  </td>
                ))}
                <td>
                  {value.steps.length > 1 && (
                    <button className="ghost" aria-label={`${t.delete} ${t.step} ${s + 1}`} onClick={() => removeStep(s)}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {value && (
        <button className="ghost" onClick={addStep}>
          + {t.addStep}
        </button>
      )}
    </div>
  );
}

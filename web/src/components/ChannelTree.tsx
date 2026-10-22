/**
 * Channels picked fixture by fixture, as in QLC+'s level selection (docs/specs/groups-masters.md,
 * « Fader de canaux ») : every fixture, by address, opens on its channels (« 001:Master Dimmer »,
 * with its DMX address), each ticked on its own; a fixture's box ticks them all. Over the fixtures
 * shown (search by name, type or address, or one group's): all, none, invert, a kind of channel
 * (intensity, colours, strobe, effects), or the same channel on every fixture that has it.
 */
import { useMemo, useState } from "react";
import { useT } from "../App";
import type { FixtureChannels } from "./FaderEditor";

export interface PickedChannel {
  fixture: string;
  offset: number;
}
interface GroupLike {
  id: string;
  name: string;
  members: { fixtures: string[]; groups: string[] };
}

const key = (c: PickedChannel) => `${c.fixture}:${c.offset}`;
const pad = (n: number) => String(n).padStart(3, "0");
const SWATCH: Record<string, string> = { red: "#e5484d", green: "#30a46c", blue: "#3e63dd", white: "#f0f0f0", amber: "#f5a524", uv: "#8e4ec6", cyan: "#05a2c2", magenta: "#d6409f", yellow: "#f5d90a", lime: "#99d52a", warmWhite: "#ffd9a0", coldWhite: "#dbe8ff" };
/** Quick picks, as QLC+'s « accès rapide »: which attributes each one ticks. */
const KINDS: Record<string, string[]> = { intensity: ["intensity"], color: ["color"], strobe: ["strobe"], effects: ["effect", "speed", "colorWheel", "other"] };

export function ChannelTree({ fixtures, groups, selected, onChange }: { fixtures: FixtureChannels[]; groups: GroupLike[]; selected: PickedChannel[]; onChange: (picked: PickedChannel[]) => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(selected.map((c) => c.fixture)));
  const [sameName, setSameName] = useState("");
  const [manual, setManual] = useState<Record<string, string>>({});
  const picked = useMemo(() => new Set(selected.map(key)), [selected]);

  const ordered = useMemo(() => [...fixtures].sort((a, b) => a.universe - b.universe || a.address - b.address), [fixtures]);
  // the fixtures of a group, sub-groups included
  const inGroup = useMemo(() => {
    if (!group) return undefined;
    const out = new Set<string>();
    const seen = new Set<string>();
    const walk = (id: string) => {
      const g = groups.find((x) => x.id === id);
      if (!g || seen.has(id)) return;
      seen.add(id);
      g.members.fixtures.forEach((f) => out.add(f));
      g.members.groups.forEach(walk);
    };
    walk(group);
    return out;
  }, [group, groups]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ordered.filter((f) => {
      if (inGroup && !inGroup.has(f.id)) return false;
      if (!q) return true;
      const where = `u${f.universe} · ${pad(f.address)}`;
      return `${f.name} ${f.type ?? ""} ${where}`.toLowerCase().includes(q) || (/^\d+$/.test(q) && pad(f.address) === q.padStart(3, "0"));
    });
  }, [ordered, query, inGroup]);

  const set = (add: PickedChannel[], remove: PickedChannel[] = []) => {
    const drop = new Set(remove.map(key));
    const next = selected.filter((c) => !drop.has(key(c)));
    for (const c of add) if (!next.some((x) => key(x) === key(c))) next.push(c);
    onChange(next);
  };
  const all = (fs: FixtureChannels[]) => fs.flatMap((f) => f.channels.map((c) => ({ fixture: f.id, offset: c.offset })));
  const names = useMemo(() => [...new Set(shown.flatMap((f) => f.channels.map((c) => c.name)))].sort((a, b) => a.localeCompare(b)), [shown]);
  const toggleOpen = (id: string) => setOpen((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id])));

  return (
    <div className="channel-tree">
      <div className="row tree-tools">
        <input type="search" placeholder={t.searchNameAddress} aria-label={t.searchNameAddress} value={query} onChange={(e) => setQuery(e.target.value)} />
        <select aria-label={t.byGroup} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">{t.byGroup} : —</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button onClick={() => set(all(shown))}>{t.pickAll}</button>
        <button onClick={() => set([], all(shown))}>{t.pickNone}</button>
        <button
          onClick={() => {
            const every = all(shown);
            set(
              every.filter((c) => !picked.has(key(c))),
              every.filter((c) => picked.has(key(c))),
            );
          }}
        >
          {t.pickInvert}
        </button>
      </div>
      <div className="row tree-tools">
        <span className="hint">{t.quickPick}</span>
        {Object.entries(KINDS).map(([kind, attributes]) => (
          <button key={kind} className="ghost" onClick={() => set(shown.flatMap((f) => f.channels.filter((c) => attributes.includes(c.attribute)).map((c) => ({ fixture: f.id, offset: c.offset }))))}>
            + {t.quickKinds[kind as keyof typeof t.quickKinds]}
          </button>
        ))}
        {/* the same channel on every fixture shown that has it: « Strobe » on all the bars */}
        <select aria-label={t.sameChannel} value={sameName} onChange={(e) => setSameName(e.target.value)}>
          <option value="">{t.sameChannel} : —</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n} ({shown.filter((f) => f.channels.some((c) => c.name === n)).length})
            </option>
          ))}
        </select>
        <button disabled={!sameName} onClick={() => set(shown.flatMap((f) => f.channels.filter((c) => c.name === sameName).map((c) => ({ fixture: f.id, offset: c.offset }))))}>
          {t.tickEverywhere}
        </button>
      </div>
      <ul className="tree" role="tree" aria-label={t.faderChannels}>
        {shown.map((f) => {
          const mine = f.channels.map((c) => ({ fixture: f.id, offset: c.offset }));
          const own = selected.filter((c) => c.fixture === f.id);
          const count = mine.filter((c) => picked.has(key(c))).length;
          const isOpen = open.has(f.id);
          return (
            <li key={f.id} role="treeitem" aria-expanded={isOpen}>
              <div className="row fixture-row">
                <button className="ghost twisty" aria-label={`${isOpen ? t.collapse : t.expand} ${f.name}`} onClick={() => toggleOpen(f.id)}>
                  {isOpen ? "▾" : "▸"}
                </button>
                {f.channels.length > 0 && (
                  <input
                    type="checkbox"
                    aria-label={f.name}
                    checked={count > 0 && count === mine.length}
                    ref={(el) => {
                      if (el) el.indeterminate = count > 0 && count < mine.length;
                    }}
                    onChange={(e) => (e.target.checked ? set(mine) : set([], mine))}
                  />
                )}
                <small className="detail">
                  U{f.universe} · {pad(f.address)}
                </small>
                <span className="grow">
                  {f.color && <span className="swatch-dot" style={{ background: f.color }} aria-hidden />}
                  {f.name}
                </span>
                <small className="hint">{f.type ?? t.noDefinitionShort}</small>
                {own.length > 0 && <span className="badge">{own.length}</span>}
              </div>
              {isOpen && (
                <ul role="group">
                  {f.channels.map((c) => {
                    const at = { fixture: f.id, offset: c.offset };
                    const label = `${pad(c.offset + 1)}:${c.name}`;
                    return (
                      <li key={c.offset} role="treeitem" className="row channel-row">
                        <input type="checkbox" aria-label={`${f.name} · ${label}`} checked={picked.has(key(at))} onChange={(e) => (e.target.checked ? set([at]) : set([], [at]))} />
                        <span className="swatch-dot" style={{ background: c.color ? SWATCH[c.color] : undefined }} aria-hidden />
                        <span className="grow">{label}</span>
                        <small className="hint">
                          {t.attributes[c.attribute as keyof typeof t.attributes] ?? c.attribute} · DMX {f.address + c.offset}
                        </small>
                      </li>
                    );
                  })}
                  {/* without a definition, channels by their number */}
                  {f.channels.length === 0 && (
                    <li className="row channel-row">
                      {own.map((c) => (
                        <button key={c.offset} className="badge" title={t.delete} onClick={() => set([], [c])}>
                          {t.channel} {c.offset + 1} ×
                        </button>
                      ))}
                      <input type="number" min={1} max={512} placeholder={t.channel} aria-label={`${f.name} · ${t.faderManualOffset}`} value={manual[f.id] ?? ""} onChange={(e) => setManual({ ...manual, [f.id]: e.target.value })} />
                      <button
                        disabled={!(Number(manual[f.id]) >= 1)}
                        onClick={() => {
                          set([{ fixture: f.id, offset: Number(manual[f.id]) - 1 }]);
                          setManual({ ...manual, [f.id]: "" });
                        }}
                      >
                        + {t.addChannel}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
        {shown.length === 0 && <li className="hint">—</li>}
      </ul>
    </div>
  );
}

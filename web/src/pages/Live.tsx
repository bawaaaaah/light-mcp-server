import { useCallback, useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents, useTopic } from "../hooks/useTopic";

interface Look {
  id: string;
  name: string;
  active: boolean;
  danger: boolean;
  manualOnly: boolean;
  tags: string[];
}
interface Group {
  id: string;
  name: string;
  exclusive: boolean;
  master?: { level: number; mute: boolean };
  members: { looks: string[] };
  effectiveLevel: number;
}
interface Tempo {
  bpm: number;
  source: string;
  clockMissing: boolean;
  beats: number;
}

export function LivePage() {
  const t = useT();
  const [looks, setLooks] = useState<Look[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const state = useTopic<{ blackout: boolean } | null>("light:state", null);
  const tempo = useTopic<Tempo | null>("light:tempo", null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    void cmd<Look[]>("look.list").then(setLooks).catch((e: Error) => setError(e.message));
    void cmd<Group[]>("group.list").then(setGroups).catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  useCommandEvents(["look.", "group.", "panic", "import.", "selftest."], refresh);

  const run = (name: string, args: unknown = {}) => cmd(name, args).catch((e: Error) => setError(e.message));
  const exclusive = groups.filter((g) => g.exclusive);
  const inExclusive = new Set(exclusive.flatMap((g) => g.members.looks));
  const others = looks.filter((l) => !inExclusive.has(l.id));
  const byId = new Map(looks.map((l) => [l.id, l]));
  const masters = groups.filter((g) => g.master);

  const lookButton = (l: Look) => (
    <button
      key={l.id}
      className={`look ${l.active ? "on" : ""} ${l.danger ? "danger" : ""}`}
      title={l.tags.join(" · ")}
      onClick={() => void run(l.active ? "look.stop" : "look.go", { id: l.id })}
    >
      {l.manualOnly ? "✋ " : ""}
      {l.name}
    </button>
  );

  return (
    <div className="live">
      <section className="bar">
        <button className="panic" onClick={() => void run("panic")}>
          {t.panic}
        </button>
        <button className={state?.blackout ? "blackout on" : "blackout"} onClick={() => void run("blackout", { on: !state?.blackout })}>
          {state?.blackout ? t.blackoutOn : t.blackout}
        </button>
        <button className="tap" onClick={() => void run("tempo.tap")}>
          {t.tap}
        </button>
        <span className="bpm">
          {tempo ? `${tempo.bpm.toFixed(1)} ${t.bpm}` : "—"} <small>{tempo?.source}</small>
          <span className={`beat ${tempo && Math.floor(tempo.beats) % 2 === 0 ? "even" : ""}`} />
        </span>
        {tempo?.clockMissing && <span className="warn">{t.clockMissing}</span>}
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </section>

      {looks.length === 0 && <p className="hint">{t.noLooks}</p>}
      {exclusive.map((g) => (
        <section key={g.id}>
          <h2>{g.name}</h2>
          <div className="grid">{g.members.looks.map((id) => byId.get(id)).filter((l): l is Look => Boolean(l)).map(lookButton)}</div>
        </section>
      ))}
      {others.length > 0 && (
        <section>
          <h2>{exclusive.length ? t.otherLooks : t.looks}</h2>
          <div className="grid">{others.map(lookButton)}</div>
        </section>
      )}

      {masters.length > 0 && (
        <section>
          <h2>{t.groups}</h2>
          <div className="faders">
            {masters.map((g) => (
              <div className="fader" key={g.id}>
                <input
                  type="range"
                  min={0}
                  max={1000}
                  value={Math.round((g.master?.level ?? 1) * 1000)}
                  onChange={(e) => {
                    const level = Number(e.target.value) / 1000;
                    setGroups((gs) => gs.map((x) => (x.id === g.id ? { ...x, master: { level, mute: x.master?.mute ?? false } } : x)));
                    void run("group.level", { id: g.id, level });
                  }}
                />
                <span className="value">
                  {Math.round((g.master?.level ?? 1) * 100)} %<small> ({Math.round(g.effectiveLevel * 100)} %)</small>
                </span>
                <button className={g.master?.mute ? "mute on" : "mute"} onClick={() => void run("group.mute", { id: g.id, mute: !g.master?.mute })}>
                  M
                </button>
                <button className="flash" onPointerDown={() => void run("group.flash", { id: g.id, on: true })} onPointerUp={() => void run("group.flash", { id: g.id, on: false })}>
                  F
                </button>
                <label>{g.name}</label>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

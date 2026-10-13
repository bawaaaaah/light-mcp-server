import { useCallback, useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";

interface Look {
  id: string;
  name: string;
  canvas: string;
  technique: { kind: string };
  timing: { every: { beats?: number; seconds?: number }; attack: number; order: string };
  tags: string[];
  active: boolean;
}
interface Group {
  id: string;
  name: string;
  exclusive: boolean;
  master?: { level: number; mute: boolean };
  members: { fixtures: string[]; looks: string[]; groups: string[] };
  effectiveLevel: number;
}
interface Canvas {
  id: string;
  name: string;
  cells: number;
}
interface Lint {
  ok: boolean;
  issues: { level: string; where: string; message: string }[];
}
interface Settings {
  safeLook?: string;
  grandMaster: number;
}

export function ShowPage() {
  const t = useT();
  const [looks, setLooks] = useState<Look[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [lint, setLint] = useState<Lint | null>(null);
  const [intent, setIntent] = useState({ name: "", mood: "", canvas: "", energy: "" });
  const [proposal, setProposal] = useState<{ explanation: string[]; unknownMoods: string[] } | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    void cmd<Look[]>("look.list").then(setLooks).catch((e: Error) => setError(e.message));
    void cmd<Group[]>("group.list").then(setGroups).catch(() => undefined);
    void cmd<Canvas[]>("venue.canvas.list").then((c) => {
      setCanvases(c);
      setIntent((i) => (i.canvas || !c[0] ? i : { ...i, canvas: c[0].id }));
    });
    void cmd<Settings>("show.settings").then(setSettings).catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  useCommandEvents(["look.", "group.put", "group.delete", "import.", "show.settings", "song.grid_fill"], refresh);
  const run = (name: string, args: unknown = {}) => cmd(name, args).catch((e: Error) => setError(e.message));

  const intentArgs = (save: boolean) => ({
    name: intent.name || intent.mood,
    canvas: intent.canvas,
    mood: intent.mood
      .split(/[,;]/)
      .map((m) => m.trim())
      .filter(Boolean),
    ...(intent.energy ? { energy: intent.energy } : {}),
    save,
  });
  const cadence = (l: Look) => ("beats" in l.timing.every && l.timing.every.beats ? `${l.timing.every.beats} t` : `${l.timing.every.seconds} s`);

  return (
    <div className="show">
      <section className="bar">
        <label>
          {t.safeLook}{" "}
          <select value={settings?.safeLook ?? ""} onChange={(e) => void run("show.settings.set", { safeLook: e.target.value || undefined })}>
            <option value="">{t.none} (Blackout)</option>
            {looks.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => void cmd<Lint>("show.lint").then(setLint)}>{t.lint}</button>
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </section>

      {lint && (
        <div className="report">
          <strong>{lint.ok ? "✔" : "✖"}</strong>
          <ul className="warnings">
            {lint.issues.map((i, k) => (
              <li key={k} className={i.level === "erreur" ? "error" : ""}>
                {i.where} : {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <h2>{t.fromIntent}</h2>
        <div className="editor">
          <input placeholder={t.name} value={intent.name} onChange={(e) => setIntent({ ...intent, name: e.target.value })} />
          <input placeholder={t.moods} value={intent.mood} onChange={(e) => setIntent({ ...intent, mood: e.target.value })} />
          <select value={intent.energy} onChange={(e) => setIntent({ ...intent, energy: e.target.value })}>
            <option value="">{t.energy} auto</option>
            <option value="pose">posé</option>
            <option value="dynamique">dynamique</option>
            <option value="survolte">survolté</option>
          </select>
          <select value={intent.canvas} onChange={(e) => setIntent({ ...intent, canvas: e.target.value })}>
            {canvases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.cells})
              </option>
            ))}
          </select>
          <button disabled={!intent.mood || !intent.canvas} onClick={() => void cmd<{ explanation: string[]; unknownMoods: string[] }>("look.from_intent", intentArgs(false)).then(setProposal).catch((e: Error) => setError(e.message))}>
            {t.dryRun}
          </button>
          <button className="primary" disabled={!intent.mood || !intent.canvas} onClick={() => void run("look.from_intent", intentArgs(true)).then(() => setProposal(null))}>
            {t.apply}
          </button>
        </div>
        {proposal && (
          <ul className="hint">
            {proposal.explanation.map((x) => (
              <li key={x}>{x}</li>
            ))}
            {proposal.unknownMoods.length > 0 && <li className="warn">? {proposal.unknownMoods.join(", ")}</li>}
          </ul>
        )}
      </section>

      <section>
        <h2>
          {t.looks} ({looks.length})
        </h2>
        <table>
          <tbody>
            {looks.map((l) => (
              <tr key={l.id}>
                <td>
                  <button className={`look ${l.active ? "on" : ""}`} onClick={() => void run(l.active ? "look.stop" : "look.go", { id: l.id })}>
                    {l.name}
                  </button>
                </td>
                <td>{l.technique.kind}</td>
                <td>{cadence(l)}</td>
                <td>{l.timing.attack < 0.2 ? "claque" : l.timing.attack > 0.8 ? "respire" : `${Math.round(l.timing.attack * 100)} %`}</td>
                <td>{l.timing.order}</td>
                <td>
                  <small>{l.tags.join(" · ")}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>
          {t.groups} ({groups.length})
        </h2>
        <table>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td>{g.name}</td>
                <td>{g.exclusive ? t.exclusive : ""}</td>
                <td>{g.master ? `${Math.round(g.master.level * 100)} % → ${Math.round(g.effectiveLevel * 100)} %` : ""}</td>
                <td>
                  <small>
                    {g.members.looks.length} looks · {g.members.fixtures.length} fixtures · {g.members.groups.length} sous-groupes
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

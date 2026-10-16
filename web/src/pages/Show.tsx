import { useCallback, useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import { labelOf } from "../util";
import { LookEditor, newLook, type LookDraft } from "../components/LookEditor";
import { GroupEditor, newGroup, type GroupDraft } from "../components/GroupEditor";
import { FaderEditor, newFader, type FaderDraft } from "../components/FaderEditor";

interface Look {
  id: string;
  name: string;
  canvas: string;
  technique: { kind: string };
  move?: { shape: string };
  timing: { every: { beats?: number; seconds?: number }; attack: number; order: string };
  tags: string[];
  active: boolean;
}
interface Group {
  id: string;
  name: string;
  exclusive: boolean;
  master?: { level: number; mute: boolean };
  limits?: { min?: number; max?: number; mode?: "clamp" | "scale" };
  members: { fixtures: string[]; looks: string[]; groups: string[] };
  effectiveLevel: number;
}
interface ChannelFader extends FaderDraft {
  id: string;
  name: string;
  level: number;
  channels: { fixture: string; offset: number }[];
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
  safeSnapshot?: string;
  grandMaster: number;
}
interface Snapshot {
  id: string;
  name: string;
  looks: string[];
  groups: Record<string, { level: number; mute: boolean }>;
  faders: Record<string, number>;
  blackout: boolean;
  savedAt?: string;
}

export function ShowPage() {
  const t = useT();
  const [looks, setLooks] = useState<Look[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [faders, setFaders] = useState<ChannelFader[]>([]);
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotName, setSnapshotName] = useState("");
  const [lint, setLint] = useState<Lint | null>(null);
  const [intent, setIntent] = useState({ name: "", mood: "", canvas: "", energy: "" });
  const [proposal, setProposal] = useState<{ explanation: string[]; unknownMoods: string[] } | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<LookDraft | null>(null);
  const [editingGroup, setEditingGroup] = useState<GroupDraft | null>(null);
  const [editingFader, setEditingFader] = useState<FaderDraft | null>(null);

  const refresh = useCallback(() => {
    void cmd<Look[]>("look.list").then(setLooks).catch((e: Error) => setError(e.message));
    void cmd<Group[]>("group.list").then(setGroups).catch(() => undefined);
    void cmd<ChannelFader[]>("fader.list").then(setFaders).catch(() => undefined);
    void cmd<Canvas[]>("venue.canvas.list").then((c) => {
      setCanvases(c);
      setIntent((i) => (i.canvas || !c[0] ? i : { ...i, canvas: c[0].id }));
    });
    void cmd<Settings>("show.settings").then(setSettings).catch(() => undefined);
    void cmd<Snapshot[]>("snapshot.list").then(setSnapshots).catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  useCommandEvents(["look.", "group.", "fader.", "import.", "show.settings", "show.autopresets", "song.grid_fill", "snapshot."], refresh);
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
  const cadence = (l: Look) => ("beats" in l.timing.every && l.timing.every.beats ? `${l.timing.every.beats} ${t.beatsShort}` : `${l.timing.every.seconds} s`);

  return (
    <div className="show">
      <section className="bar">
        <label title={t.safeStateHelp}>
          {t.safeState}{" "}
          <select
            value={settings?.safeSnapshot ? `snapshot:${settings.safeSnapshot}` : settings?.safeLook ? `look:${settings.safeLook}` : ""}
            onChange={(e) => {
              const [kind, id] = e.target.value.split(/:(.*)/);
              void run("show.settings.set", kind === "snapshot" ? { safeSnapshot: id } : { safeSnapshot: undefined, safeLook: kind === "look" ? id : undefined });
            }}
          >
            <option value="">{t.none} ({t.blackout})</option>
            <optgroup label={t.snapshots}>
              {snapshots.map((s) => (
                <option key={s.id} value={`snapshot:${s.id}`}>
                  {s.name}
                </option>
              ))}
            </optgroup>
            <optgroup label={t.looks}>
              {looks.map((l) => (
                <option key={l.id} value={`look:${l.id}`}>
                  {l.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <button onClick={() => void cmd<Lint>("show.lint").then(setLint)}>{t.lint}</button>
        <button
          title={t.autopresetsHelp}
          onClick={() =>
            void cmd<{ created: string[]; kept: string[]; canvas: string; safeLook?: string }>("show.autopresets", {})
              .then((p) => {
                if (!p.created.length) return setError(t.autopresetsNothing);
                const summary = `${t.autopresets} (${p.canvas}) :\n${p.created.join("\n")}${p.safeLook ? `\n\n${t.safeLook} : ${p.safeLook}` : ""}`;
                if (confirm(summary)) return cmd("show.autopresets", { apply: true }).then(refresh);
              })
              .catch((e: Error) => setError(e.message))
          }
        >
          ★ {t.autopresets}
        </button>
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

      <section className="snapshots">
        <h2>{t.snapshots}</h2>
        <p className="hint">{t.snapshotsHelp}</p>
        <div className="row">
          <input aria-label={t.snapshotName} placeholder={t.snapshotName} value={snapshotName} onChange={(e) => setSnapshotName(e.target.value)} />
          <button className="primary" disabled={!snapshotName.trim()} onClick={() => void run("snapshot.save", { name: snapshotName.trim() }).then(() => setSnapshotName(""))}>
            {t.saveSnapshot}
          </button>
        </div>
        <table>
          <tbody>
            {snapshots.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.name}
                  {settings?.safeSnapshot === s.id && <span className="badge standby"> {t.safeBadge}</span>}
                </td>
                <td className="hint">
                  {s.looks.length} look(s) · {Object.keys(s.groups).length} DCA · {Object.keys(s.faders).length} fader(s){s.blackout ? " · Blackout" : ""}
                </td>
                <td className="row">
                  <button onClick={() => void run("snapshot.recall", { id: s.id })}>{t.recall}</button>
                  <button title={t.overwriteHelp} onClick={() => confirm(`${t.overwriteConfirm} « ${s.name} »`) && void run("snapshot.save", { id: s.id, name: s.name })}>
                    {t.overwrite}
                  </button>
                  <button className="ghost" onClick={() => confirm(`${t.delete} « ${s.name} » ?`) && void run("snapshot.delete", { id: s.id })}>
                    {t.delete}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>{t.fromIntent}</h2>
        <div className="editor">
          <input placeholder={t.name} value={intent.name} onChange={(e) => setIntent({ ...intent, name: e.target.value })} />
          <input placeholder={t.moods} value={intent.mood} onChange={(e) => setIntent({ ...intent, mood: e.target.value })} />
          <select value={intent.energy} onChange={(e) => setIntent({ ...intent, energy: e.target.value })}>
            <option value="">
              {t.energy} {t.auto}
            </option>
            {(["pose", "dynamique", "survolte"] as const).map((e) => (
              <option key={e} value={e}>
                {t.energies[e]}
              </option>
            ))}
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

      {editing && (
        <LookEditor
          key={editing.id || "new"}
          initial={editing}
          existing={looks.map((l) => l.id)}
          onClose={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}

      <section>
        <h2>
          {t.looks} ({looks.length}){" "}
          <button className="ghost" onClick={() => setEditing(newLook(canvases[0]?.id ?? ""))}>
            + {t.newLook}
          </button>
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
                <td>
                  {labelOf(t.techniqueNames, l.technique.kind)}
                  {l.move && <small> · ↻ {labelOf(t.moveShapes, l.move.shape)}</small>}
                </td>
                <td>{cadence(l)}</td>
                <td>{l.timing.attack < 0.2 ? t.snap : l.timing.attack > 0.8 ? t.breathe : `${Math.round(l.timing.attack * 100)} %`}</td>
                <td>{labelOf(t.orders, l.timing.order)}</td>
                <td>
                  <small>{l.tags.join(" · ")}</small>
                </td>
                <td>
                  <button className="ghost" title={t.edit} aria-label={`${t.edit} ${l.name}`} onClick={() => setEditing(l as unknown as LookDraft)}>
                    ✎
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {editingGroup && (
        <GroupEditor
          key={editingGroup.id || "new-group"}
          initial={editingGroup}
          existing={groups.map((g) => g.id)}
          onClose={() => {
            setEditingGroup(null);
            refresh();
          }}
        />
      )}
      <section>
        <h2>
          {t.groupsDca} ({groups.length}){" "}
          <button className="ghost" onClick={() => setEditingGroup(newGroup())}>
            + {t.newGroup}
          </button>
        </h2>
        <table>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td className="nowrap">
                  <button className="ghost" aria-label={`${t.edit} ${g.name}`} onClick={() => setEditingGroup(g as unknown as GroupDraft)}>
                    ✎
                  </button>{" "}
                  {g.name}
                </td>
                <td>{g.exclusive ? t.exclusive : ""}</td>
                <td>{g.master ? `DCA ${Math.round(g.master.level * 100)} % → ${Math.round(g.effectiveLevel * 100)} %` : ""}</td>
                <td>
                  {g.master && (
                    <span className="row dca-limits">
                      {(["min", "max"] as const).map((k) => (
                        <label key={k} className="inline">
                          {k}
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={5}
                            aria-label={`${k} ${g.name}`}
                            placeholder={k === "min" ? "0" : "100"}
                            defaultValue={g.limits?.[k] !== undefined ? Math.round(g.limits[k]! * 100) : ""}
                            onBlur={(e) => {
                              const v = e.target.value === "" ? undefined : Number(e.target.value) / 100;
                              const { effectiveLevel: _e, ...group } = g;
                              void run("group.put", { group: { ...group, limits: { ...g.limits, mode: g.limits?.mode ?? "clamp", [k]: v } } }).then(refresh);
                            }}
                          />
                        </label>
                      ))}
                      <select
                        aria-label={`${t.dcaMode} ${g.name}`}
                        value={g.limits?.mode ?? "clamp"}
                        onChange={(e) => {
                          const { effectiveLevel: _e, ...group } = g;
                          void run("group.put", { group: { ...group, limits: { ...g.limits, mode: e.target.value } } }).then(refresh);
                        }}
                      >
                        <option value="clamp">{t.dcaClamp}</option>
                        <option value="scale">{t.dcaScale}</option>
                      </select>
                    </span>
                  )}
                </td>
                <td>
                  <small>
                    {g.members.looks.length} looks · {g.members.fixtures.length} fixtures · {g.members.groups.length} {t.subGroups.toLowerCase()}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {editingFader && (
        <FaderEditor
          key={editingFader.id || "new-fader"}
          initial={editingFader}
          existing={faders.map((f) => f.id)}
          onClose={() => {
            setEditingFader(null);
            refresh();
          }}
        />
      )}
      <section>
        <h2>
          {t.channelFaders} ({faders.length}){" "}
          <button className="ghost" onClick={() => setEditingFader(newFader())}>
            + {t.newFader}
          </button>
        </h2>
        <p className="hint">{t.channelFadersHelp}</p>
        <table>
          <tbody>
            {faders.map((f) => (
              <tr key={f.id}>
                <td>
                  <button className="ghost" aria-label={`${t.edit} ${f.name}`} onClick={() => setEditingFader(f)}>
                    ✎
                  </button>{" "}
                  {f.name}
                </td>
                <td>
                  <small>{f.channels.map((c) => `${c.fixture}+${c.offset + 1}`).join(", ")}</small>
                </td>
                <td>{Math.round(f.level * 100)} %</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

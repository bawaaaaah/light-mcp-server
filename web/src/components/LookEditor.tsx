/**
 * Look editor (docs/specs/ui-dashboards.md, « Éditeur d'effets ») : technique and its parameters
 * (form generated from the server's schema), « pas » step editor, palette by reference, timing
 * (cadence in beats or seconds, attack, order), Move FX for moving heads, flags, tags and notes,
 * with an animated preview computed by the server. Everything is saved with `look.put`.
 */
import { RawChannelsEditor, type LookChannelsDraft } from "./RawChannelsEditor";
import { useEffect, useMemo, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useTopic } from "../hooks/useTopic";
import { defaultsFor, SchemaFields, type JsonSchema } from "./SchemaFields";
import { StepsEditor } from "./StepsEditor";
import { canvasBlocks, type CanvasRender } from "../canvas-blocks";
import { LookPreview, type Preview } from "./LookPreview";
import { labelOf, slug, splitList, uniqueId } from "../util";
import { confirmDelete } from "./confirmDelete";
import { Versions } from "./Versions";

type Every = { beats: number } | { seconds: number };
interface Move {
  shape: string;
  center: { pan: number; tilt: number };
  size: { pan: number; tilt: number };
  every: Every;
  spread?: number;
  wings: boolean;
  reverse: boolean;
  shuffle?: boolean;
  fan: number;
  group?: string;
}
export interface LookDraft {
  id: string;
  name: string;
  canvas: string;
  technique: Record<string, unknown> & { kind: string };
  palette?: string;
  timing: { every: Every; attack: number; order: string; weights?: number[]; entryFade: number };
  move?: Move;
  channels?: LookChannelsDraft;
  mirror?: boolean;
  manualOnly: boolean;
  noCut: boolean;
  danger: boolean;
  tags: string[];
  notes?: string;
}
interface Named {
  id: string;
  name: string;
  cells?: number;
  /** A canvas: which fixture each cell drives. */
  render?: CanvasRender[];
  /** A fixture's marker colour. */
  color?: string;
}

export function newLook(canvas: string): LookDraft {
  return { id: "", name: "", canvas, technique: { kind: "plat", color: "#ffffff" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 }, manualOnly: false, noCut: false, danger: false, tags: [] };
}

const MOVE: Move = { shape: "fixe", center: { pan: 0.5, tilt: 0.5 }, size: { pan: 0.1, tilt: 0.1 }, every: { beats: 4 }, wings: false, reverse: false, fan: 0 };

function EveryInput({ value, onChange }: { value: Every; onChange: (v: Every) => void }) {
  const t = useT();
  const beats = "beats" in value;
  const n = beats ? value.beats : value.seconds;
  return (
    <span className="row">
      <input type="number" min={0.0625} step={beats ? 0.25 : 0.1} value={n} onChange={(e) => Number(e.target.value) > 0 && onChange(beats ? { beats: Number(e.target.value) } : { seconds: Number(e.target.value) })} />
      <select value={beats ? "beats" : "seconds"} onChange={(e) => onChange(e.target.value === "beats" ? { beats: n } : { seconds: n })}>
        <option value="beats">{t.beats}</option>
        <option value="seconds">{t.seconds}</option>
      </select>
    </span>
  );
}

export function LookEditor({ initial, existing, onClose }: { initial: LookDraft; existing: string[]; onClose: (saved?: string) => void }) {
  const t = useT();
  const [look, setLook] = useState<LookDraft>(initial);
  const isNew = !look.id;
  const [kinds, setKinds] = useState<{ kind: string; schema: JsonSchema }[]>([]);
  const [canvases, setCanvases] = useState<Named[]>([]);
  const [palettes, setPalettes] = useState<Named[]>([]);
  const [groups, setGroups] = useState<Named[]>([]);
  const [fixtures, setFixtures] = useState<Named[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [hasHeads, setHasHeads] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const tempo = useTopic<{ bpm: number } | null>("light:tempo", null);

  useEffect(() => {
    void cmd<{ kind: string; schema: JsonSchema }[]>("look.techniques").then(setKinds);
    void cmd<Named[]>("venue.canvas.list").then(setCanvases);
    void cmd<Named[]>("palette.list").then(setPalettes);
    void cmd<Named[]>("group.list").then(setGroups);
    void cmd<Named[]>("venue.fixture.list").then(setFixtures).catch(() => undefined);
    void cmd<unknown[]>("position.list").then((h) => setHasHeads(h.length > 0));
  }, []);

  const id = isNew ? uniqueId(slug(look.name, "look"), existing) : look.id;
  const draft = useMemo(() => ({ ...look, id: id || "look" }), [look, id]);
  const canvas = canvases.find((c) => c.id === look.canvas);
  const cells = canvas?.cells ?? 8;
  const blocks = useMemo(() => canvasBlocks(cells, canvas?.render ?? [], fixtures), [cells, canvas, fixtures]);

  // Server-side preview, debounced: the same generator as the show.
  useEffect(() => {
    if (!look.canvas) return;
    const timer = window.setTimeout(() => {
      void cmd<Preview>("look.preview", { look: draft })
        .then((p) => (setPreview(p), setError("")))
        .catch((e: Error) => setError(e.message));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, look.canvas]);

  const schema = kinds.find((k) => k.kind === look.technique.kind)?.schema;
  const set = (patch: Partial<LookDraft>) => setLook((l) => ({ ...l, ...patch }));
  const setTiming = (patch: Partial<LookDraft["timing"]>) => setLook((l) => ({ ...l, timing: { ...l.timing, ...patch } }));
  const setMove = (patch: Partial<Move>) => setLook((l) => ({ ...l, move: { ...(l.move ?? MOVE), ...patch } }));
  const changeKind = (kind: string) => {
    const s = kinds.find((k) => k.kind === kind)?.schema;
    if (s) set({ technique: defaultsFor(s, look.technique, cells) as LookDraft["technique"] });
  };

  const save = async (andPlay = false) => {
    if (!look.name.trim()) return setError(t.nameRequired);
    try {
      await cmd("look.put", { look: draft });
      if (andPlay) await cmd("look.go", { id: draft.id });
      onClose(draft.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="look-editor">
      <h2>{isNew ? t.newLook : `${t.editLook} · ${initial.name}`}</h2>
      {preview && <LookPreview preview={preview} timing={look.timing} bpm={tempo?.bpm ?? 120} label={t.preview} />}
      <div className="fields">
        <label className="field">
          <span>{t.name}</span>
          <input value={look.name} onChange={(e) => set({ name: e.target.value })} />
          {isNew && look.name && <small>id : {id}</small>}
        </label>
        <label className="field">
          <span>{t.canvas}</span>
          <select value={look.canvas} onChange={(e) => set({ canvas: e.target.value })}>
            {canvases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.cells})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.technique}</span>
          <select value={look.technique.kind} onChange={(e) => changeKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {labelOf(t.techniqueNames, k.kind)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.palette}</span>
          <select value={look.palette ?? ""} onChange={(e) => set({ palette: e.target.value || undefined })}>
            <option value="">—</option>
            {palettes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.mirror}</span>
          <select value={look.mirror === undefined ? "" : String(look.mirror)} onChange={(e) => set({ mirror: e.target.value === "" ? undefined : e.target.value === "true" })}>
            <option value="">{t.auto}</option>
            <option value="true">{t.yes}</option>
            <option value="false">{t.no}</option>
          </select>
        </label>
      </div>

      {schema && <SchemaFields schema={schema} values={look.technique} onChange={(v) => set({ technique: v as LookDraft["technique"] })} skip={look.palette ? ["colors", "color", "base"] : []} />}
      {look.technique.kind === "pas" && <StepsEditor steps={(look.technique.steps as string[][]) ?? [[]]} cells={cells} blocks={blocks} onChange={(steps) => set({ technique: { ...look.technique, steps } })} />}

      <h3>{t.timing}</h3>
      <div className="fields">
        <label className="field">
          <span>{t.every}</span>
          <EveryInput value={look.timing.every} onChange={(every) => setTiming({ every })} />
        </label>
        <label className="field">
          <span>
            {t.attack} · {look.timing.attack < 0.2 ? t.snap : look.timing.attack > 0.8 ? t.breathe : `${Math.round(look.timing.attack * 100)} %`}
          </span>
          <input type="range" min={0} max={1} step={0.05} value={look.timing.attack} onChange={(e) => setTiming({ attack: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t.order}</span>
          <select value={look.timing.order} onChange={(e) => setTiming({ order: e.target.value })}>
            {["loop", "pingpong", "random", "weighted"].map((o) => (
              <option key={o} value={o}>
                {labelOf(t.orders, o)}
              </option>
            ))}
          </select>
        </label>
        {look.timing.order === "weighted" && (
          <label className="field">
            <span>{t.weights}</span>
            <input
              placeholder="1, 1, 4…"
              defaultValue={(look.timing.weights ?? []).join(", ")}
              onBlur={(e) => {
                const w = e.target.value.split(/[,; ]+/).filter(Boolean).map(Number);
                setTiming({ weights: w.length && w.every((x) => x >= 0) ? w : undefined });
              }}
            />
          </label>
        )}
        <label className="field">
          <span>{t.entryFade} (s)</span>
          <input type="number" min={0} max={30} step={0.1} value={look.timing.entryFade} onChange={(e) => setTiming({ entryFade: Number(e.target.value) })} />
        </label>
      </div>

      {(hasHeads || look.move) && (
        <>
          <h3>
            <label className="row">
              <input type="checkbox" checked={Boolean(look.move)} onChange={(e) => set({ move: e.target.checked ? MOVE : undefined })} /> {t.moveFx}
            </label>
          </h3>
          {look.move && (
            <div className="fields">
              <label className="field">
                <span>{t.shape}</span>
                <select value={look.move.shape} onChange={(e) => setMove({ shape: e.target.value })}>
                  {["fixe", "cercle", "huit", "pan", "tilt", "tapis", "aleatoire"].map((s) => (
                    <option key={s} value={s}>
                      {labelOf(t.moveShapes, s)}
                    </option>
                  ))}
                </select>
              </label>
              {(["pan", "tilt"] as const).map((axis) => (
                <label key={axis} className="field">
                  <span>
                    {t.center} {axis}
                  </span>
                  <input type="range" min={0} max={1} step={0.01} value={look.move!.center[axis]} onChange={(e) => setMove({ center: { ...look.move!.center, [axis]: Number(e.target.value) } })} />
                </label>
              ))}
              {look.move.shape !== "fixe" &&
                (["pan", "tilt"] as const).map((axis) => (
                  <label key={axis} className="field">
                    <span>
                      {t.size} {axis}
                    </span>
                    <input type="range" min={0} max={0.5} step={0.01} value={look.move!.size[axis]} onChange={(e) => setMove({ size: { ...look.move!.size, [axis]: Number(e.target.value) } })} />
                  </label>
                ))}
              {look.move.shape !== "fixe" && (
                <>
                  <label className="field">
                    <span>{t.cycle}</span>
                    <EveryInput value={look.move.every} onChange={(every) => setMove({ every })} />
                  </label>
                  <label className="field">
                    <span>{t.fields.spread}</span>
                    <input type="number" min={0} max={4} step={0.25} placeholder={t.auto} value={look.move.spread ?? ""} onChange={(e) => setMove({ spread: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    <span>{t.fields.wings}</span>
                    <input type="checkbox" checked={look.move.wings} onChange={(e) => setMove({ wings: e.target.checked })} />
                  </label>
                  <label className="field">
                    <span>{t.fields.reverse}</span>
                    <input type="checkbox" checked={look.move.reverse} onChange={(e) => setMove({ reverse: e.target.checked })} />
                  </label>
                  <label className="field" title={t.shuffleHelp}>
                    <span>{t.fields.shuffle}</span>
                    <input type="checkbox" checked={Boolean(look.move.shuffle)} onChange={(e) => setMove({ shuffle: e.target.checked || undefined })} />
                  </label>
                </>
              )}
              <label className="field">
                <span>{t.fan}</span>
                <input type="range" min={-0.5} max={0.5} step={0.01} value={look.move.fan} onChange={(e) => setMove({ fan: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>{t.group}</span>
                <select value={look.move.group ?? ""} onChange={(e) => setMove({ group: e.target.value || undefined })}>
                  <option value="">{t.canvasHeads}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </>
      )}

      <h3>
        <label className="row">
          <input type="checkbox" checked={Boolean(look.channels) || rawOpen} onChange={(e) => (setRawOpen(e.target.checked), e.target.checked || set({ channels: undefined }))} /> {t.rawChannels}
        </label>
      </h3>
      {(look.channels || rawOpen) && <RawChannelsEditor value={look.channels} onChange={(channels) => set({ channels })} />}

      <h3>{t.flags}</h3>
      <div className="fields">
        {(["manualOnly", "noCut", "danger"] as const).map((f) => (
          <label key={f} className="field">
            <span>{t.flagNames[f]}</span>
            <input type="checkbox" checked={look[f]} onChange={(e) => set({ [f]: e.target.checked })} />
          </label>
        ))}
        <label className="field">
          <span>tags</span>
          <input defaultValue={look.tags.join(", ")} onBlur={(e) => set({ tags: splitList(e.target.value) })} />
        </label>
      </div>
      <textarea placeholder={t.notes} value={look.notes ?? ""} onChange={(e) => set({ notes: e.target.value || undefined })} />

      <div className="row actions">
        <button className="primary" onClick={() => void save()}>
          {t.save}
        </button>
        <button onClick={() => void save(true)}>{t.saveAndPlay}</button>
        {!isNew && <button onClick={() => setLook({ ...look, id: "", name: `${look.name} (${t.copySuffix})` })}>{t.duplicate}</button>}
        <button className="ghost" onClick={() => onClose()}>
          {t.close}
        </button>
        {!isNew && (
          <button
            className="ghost danger"
            onClick={() => {
              void confirmDelete("look", initial.id, initial.name, t).then((done) => done && onClose(), (e: Error) => setError(e.message));
            }}
          >
            {t.delete}
          </button>
        )}
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </div>
      {!isNew && <Versions collection="looks" id={initial.id} onRestored={() => onClose()} />}
    </section>
  );
}

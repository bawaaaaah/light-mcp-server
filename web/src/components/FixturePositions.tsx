/**
 * The named positions in the panel of a moving head (T32, lot 4; docs/specs/venue-fixtures-stage.md, « Positions
 * nommées »): recall one on this head (the positions that cover it, and the points, found by name in a SearchPicker,
 * the one it holds marked « rappelée », a stale one « à revoir »), and « Enregistrer cette position… » — an inline form:
 * a name, pan/tilt (what is seen now) or a 3D point, the heads covered (this one, several, all), a colour. Recalling
 * asks `commands:position`, saving `show:write`; a refusal is said in the app's toast (positionRecall.ts).
 */
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { EditorActions } from "./EditorActions";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { usePositions, type PositionRow } from "../hooks/usePositions";
import { AXES, pointFields, pointOf, wrongAxis as firstWrongAxis, type SaveReply } from "../positionForm";
import { recallPosition } from "../positionRecall";
import type { SearchItem } from "../search-picker";
import { quoted } from "../typography";
import { showLockToast } from "./MotionLockButton";
import { SearchPicker } from "./SearchPicker";
import { SwatchPicker } from "./SwatchPicker";

type Kind = "pantilt" | "point";
type Heads = "this" | "some" | "all";
interface Named {
  id: string;
  name: string;
}

/** Whether a position places this head: a pan/tilt one that covers it, or any point. */
const places = (p: PositionRow, head: string): boolean => p.kind === "point" || Object.hasOwn(p.values, head);

/** Shown to whoever may move the heads (the panel's pad); saving asks `show:write` too. */
export function FixturePositions({ fixture, canSave }: { fixture: Named; canSave: boolean }): ReactElement {
  const t = useT();
  const w = t.positions;
  const { positions, loaded } = usePositions();
  const { heads } = useMotionHeads({ fixtures: [fixture.id] });
  const recalled = heads.find((h) => h.id === fixture.id)?.recalled;
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const mine = positions.filter((p) => places(p, fixture.id));
  const items: SearchItem[] = mine.map((p) => ({
    key: p.id,
    label: p.name,
    ...(p.color ? { color: p.color } : {}),
    ...(p.stale.includes(fixture.id) ? { badge: w.stale } : {}),
    ...(p.kind === "point" ? { detail: w.kindPoint } : {}),
    current: recalled === p.id,
  }));
  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => opener.current?.focus());
  };
  return (
    <div className="position-tools">
      {loaded &&
        (items.length ? (
          <>
            <SearchPicker
              title={w.panelRecall}
              items={items}
              currentLabel={w.recalledBadge}
              onPick={(item) => {
                const p = mine.find((x) => x.id === item.key);
                if (p) void recallPosition(t, p.id, p.name, (id) => (id === fixture.id ? fixture.name : id), [fixture.id]);
              }}
            />
            <small className="hint">{w.panelRecallHelp}</small>
          </>
        ) : (
          <small className="hint">{w.panelNone}</small>
        ))}
      {canSave &&
        (open ? (
          <SavePositionForm fixture={fixture} onDone={close} />
        ) : (
          <button ref={opener} type="button" className="position-save-open" aria-expanded={false} onClick={() => setOpen(true)}>
            {w.save}
          </button>
        ))}
    </div>
  );
}

/** « Enregistrer cette position… »: the inline form (never a prompt()), closed by Save or Close. */
function SavePositionForm({ fixture, onDone }: { fixture: Named; onDone: () => void }): ReactElement {
  const t = useT();
  const w = t.positions;
  const formId = useId();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("pantilt");
  const [heads, setHeads] = useState<Heads>("this");
  const [some, setSome] = useState<string[]>([fixture.id]);
  // empty, never 0/0/0: a point is typed, not taken by default
  const [point, setPoint] = useState(() => pointFields(undefined, t.decimalMark));
  const [keep, setKeep] = useState(false);
  const [color, setColor] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The installed moving heads, read once when the form opens: « Plusieurs lyres » ticks among them. */
  const [installed, setInstalled] = useState<Named[]>([]);
  const form = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>("input")?.focus();
    void cmd<Named[]>("position.list").then((list) => setInstalled(list.map((h) => ({ id: h.id, name: h.name }))), () => undefined);
  }, []);
  const nameOf = (id: string) => installed.find((h) => h.id === id)?.name ?? (id === fixture.id ? fixture.name : id);
  /** The heads it captures: none for a point (each placed head aims at it when recalled) unless aimed now. */
  const capturesHeads = kind === "pantilt" || keep;
  const wrongAxis = kind === "point" ? firstWrongAxis(point) : undefined;

  const save = async () => {
    setTried(true);
    if (!name.trim()) return setProblem(w.nameRequired);
    if (wrongAxis) {
      form.current?.querySelector<HTMLInputElement>(`input[data-axis="${wrongAxis}"]`)?.focus();
      return setProblem(w.pointNumber);
    }
    if (capturesHeads && heads === "some" && !some.length) return setProblem(w.headsPick);
    const fixtures = !capturesHeads || heads === "all" ? undefined : heads === "this" ? [fixture.id] : some;
    setBusy(true);
    try {
      const reply = await cmd<SaveReply>("position.preset.save", {
        name: name.trim(),
        ...(color ? { color } : {}),
        ...(kind === "point" ? { point: pointOf(point), ...(keep ? { pantilt: true } : {}) } : {}),
        ...(fixtures ? { fixtures } : {}),
      });
      const said = [w.saved.replace("{name}", () => quoted(t, reply.position.name))];
      if (reply.unreachable?.length) said.push(w.unreachable.replace("{names}", () => reply.unreachable!.map((u) => `${nameOf(u.fixture)} (${u.error})`).join(", ")));
      // a success is said quietly; heads left out are a warning
      showLockToast(said.join(" · "), reply.unreachable?.length ? "alert" : "neutral");
      onDone();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      ref={form}
      id={formId}
      className="position-form"
      aria-label={w.saveTitle.replace("{name}", () => quoted(t, fixture.name))}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        // Escape closes the form, not the fixture panel around it
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <label className="field">
        <span>{t.name}</span>
        <input value={name} aria-required="true" aria-invalid={tried && !name.trim() ? true : undefined} onChange={(e) => (setName(e.target.value), setProblem(""))} />
      </label>
      <fieldset>
        <legend>{w.kindLegend}</legend>
        {(["pantilt", "point"] as const).map((k) => (
          <label key={k} className="choice">
            <input type="radio" name={`${formId}-kind`} checked={kind === k} onChange={() => (setKind(k), setProblem(""))} />
            {k === "pantilt" ? w.kindPantilt : w.kindPoint}
          </label>
        ))}
      </fieldset>
      {kind === "point" && (
        <fieldset>
          <legend>{w.pointLegend}</legend>
          <div className="position-point">
            {AXES.map((a) => {
              const wrong = tried && a === wrongAxis;
              return (
                <label key={a} className="field">
                  <span>{w.pointAxis.replace("{axis}", a.toUpperCase())}</span>
                  <input type="text" inputMode="decimal" data-axis={a} aria-invalid={wrong || undefined} value={point[a]} onChange={(e) => (setPoint({ ...point, [a]: e.target.value }), setProblem(""))} />
                </label>
              );
            })}
          </div>
          <label className="choice">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            {w.pointPantilt}
          </label>
          <small className="hint">{w.pointPantiltHelp}</small>
        </fieldset>
      )}
      {capturesHeads && (
        <fieldset>
          <legend>{w.headsLegend}</legend>
          {(["this", "some", "all"] as const).map((h) => (
            <label key={h} className="choice">
              <input type="radio" name={`${formId}-heads`} checked={heads === h} onChange={() => (setHeads(h), setProblem(""))} />
              {h === "this" ? `${w.headsThis} (${fixture.name})` : h === "some" ? w.headsSome : w.headsAll.replace("{n}", String(installed.length || "…"))}
            </label>
          ))}
          {heads === "some" && (
            <div className="position-heads">
              {installed.map((h) => (
                <label key={h.id} className="choice">
                  <input type="checkbox" checked={some.includes(h.id)} onChange={(e) => (setSome(e.target.checked ? [...some, h.id] : some.filter((x) => x !== h.id)), setProblem(""))} />
                  {h.name}
                </label>
              ))}
            </div>
          )}
          {kind === "pantilt" && <small className="hint">{w.captureHelp}</small>}
        </fieldset>
      )}
      <SwatchPicker label={w.color} noneLabel={w.noColor} value={color} onChange={setColor} />
      <EditorActions saveDisabled={busy} onClose={onDone} error={problem} />
    </form>
  );
}


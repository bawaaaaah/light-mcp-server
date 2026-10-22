/**
 * Rules and limits (docs/specs/rules-limits.md): list, create (level, scope, target, min/max,
 * forbidden modes, locked), the effective rule of each channel of a fixture with its provenance,
 * and the values the rules moved on the last frame. Values are shown in % of the DMX range.
 */
import { useCallback, useEffect, useState } from "react";
import { api, can, cmd } from "../api";
import { useMe, useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import { slug, uniqueId } from "../util";

interface Rule {
  id: string;
  name: string;
  level: "type" | "venue" | "show";
  scope: { model?: string; fixture?: string; zone?: string };
  target: { channel?: string; attribute?: string; color?: string; tag?: string };
  min?: number;
  max?: number;
  maxHz?: number;
  hold?: { above: number; seconds: number };
  maxDegPerSecond?: number;
  steadySeconds?: number;
  allowCapabilities?: string[];
  onViolation?: "clamp" | "confirm" | "reject";
  appliesTo?: { origins?: string[]; roles?: string[] };
  forbidTags?: string[];
  locked: boolean;
  program?: string;
}
interface Program {
  id: string;
  name: string;
  programChange?: number;
  channel: number;
}
interface Effective {
  channel: string;
  dmx: number;
  attribute: string;
  min?: number;
  max?: number;
  maxHz?: number;
  values?: number[];
  forbidTags?: string[];
  from: Record<string, string>;
  locked: string[];
}
interface Named {
  id: string;
  name: string;
  model?: string;
  manufacturer?: string;
}

const TARGETS: Record<string, Rule["target"]> = {
  intensity: { attribute: "intensity" },
  uv: { color: "uv" },
  white: { color: "white" },
  strobe: { attribute: "strobe" },
  pan: { attribute: "pan" },
  tilt: { attribute: "tilt" },
  effect: { attribute: "effect" },
  machine: { tag: "machine" },
  all: {},
};
const TAGS = ["soundActive", "autoProgram", "builtinMacro", "strobe", "reset", "uv", "machine"] as const;
/** Kinds of capability ranges an allowlist names (qxf-import.ts, CAPABILITY_KINDS). */
const KINDS = ["colour", "intensity", "strobe", "gobo", "prism", "beam", "rotation", "speed", "effect", "maintenance"] as const;
/** Callers a rule can be for, beside everyone: where the command comes from. */
const ORIGINS = ["mcp", "midi", "osc", "timeline"] as const;
/** The built-in roles, when the full list (an administrator's) is not readable. */
const BUILT_IN_ROLES = [
  { id: "regisseur", name: "Régisseur" },
  { id: "benevole", name: "Bénévole" },
  { id: "lecture", name: "Lecture seule" },
];
const pct = (v?: number) => (v === undefined ? "" : `${Math.round((v / 255) * 100)} %`);
const toDmx = (p: string) => (p === "" ? undefined : Math.round((Number(p) / 100) * 255));

export function RulesPanel({ fixtures, zones, onError }: { fixtures: Named[]; zones: Named[]; onError: (msg: string) => void }) {
  const t = useT();
  const [rules, setRules] = useState<{ venue: Rule[]; show: Rule[]; clamps: { fixture: string; channel: string; from: number; to: number; rule: string }[] }>({ venue: [], show: [], clamps: [] });
  const [draft, setDraft] = useState({ name: "", level: "show" as Rule["level"], scope: "all", scopeValue: "", target: "intensity", channel: "", min: "", max: "", maxHz: "", holdAbove: "", holdSeconds: "", maxDeg: "", steady: "", allow: [] as string[], onViolation: "clamp", forOrigins: [] as string[], forRoles: [] as string[], forbid: [] as string[], locked: false, program: "" });
  const [programs, setPrograms] = useState<{ active: string | null; programs: Program[] }>({ active: null, programs: [] });
  const [roles, setRoles] = useState<{ id: string; name: string }[]>(BUILT_IN_ROLES);
  // the custom roles too, for whoever may read them (an administrator)
  const me = useMe();
  useEffect(() => {
    if (me && can(me, "auth:admin")) void api<{ id: string; name: string }[]>("/api/auth/roles").then((list) => setRoles(list.filter((r) => r.id !== "admin")), () => undefined);
  }, [me]);
  const [progDraft, setProgDraft] = useState({ name: "", pc: "", channel: "1" });
  const loadPrograms = useCallback(() => void cmd<typeof programs>("program.list").then(setPrograms).catch(() => undefined), []);
  const [inspect, setInspect] = useState("");
  const [effective, setEffective] = useState<Effective[]>([]);

  const refresh = useCallback(() => {
    void cmd<typeof rules>("rule.list").then(setRules).catch((e: Error) => onError(e.message));
  }, [onError]);
  useEffect(refresh, [refresh]);
  useCommandEvents(["rule."], refresh);
  useEffect(loadPrograms, [loadPrograms]);
  useCommandEvents(["program."], loadPrograms);
  useEffect(() => {
    if (inspect) void cmd<Effective[]>("rule.effective", { fixture: inspect }).then(setEffective).catch((e: Error) => onError(e.message)); // with the active program
    else setEffective([]);
  }, [inspect, rules, programs.active, onError]);

  const models = [...new Set(fixtures.map((f) => f.model).filter((m): m is string => Boolean(m)))];
  const all = [...rules.venue.map((r) => ({ ...r, where: "venue" as const })), ...rules.show.map((r) => ({ ...r, where: "show" as const }))];
  const scopeText = (r: Rule) => (r.scope.fixture ? fixtures.find((f) => f.id === r.scope.fixture)?.name ?? r.scope.fixture : r.scope.zone ? `${t.zone} ${zones.find((z) => z.id === r.scope.zone)?.name ?? r.scope.zone}` : r.scope.model ? r.scope.model : t.everything);
  const targetText = (r: Rule) => {
    if (r.target.channel) return r.target.channel;
    const key = Object.entries(TARGETS).find(([, v]) => JSON.stringify(v) === JSON.stringify(r.target))?.[0];
    return key ? t.ruleTargets[key as keyof typeof t.ruleTargets] : JSON.stringify(r.target);
  };

  const add = () => {
    const target = draft.target === "channel" ? { channel: draft.channel } : TARGETS[draft.target]!;
    const name = draft.name || `${t.ruleTargets[draft.target as keyof typeof t.ruleTargets] ?? draft.channel}${draft.max ? ` max ${draft.max} %` : ""}${draft.min ? ` min ${draft.min} %` : ""}${draft.maxHz ? ` ≤ ${draft.maxHz} Hz` : ""}${draft.holdAbove && draft.holdSeconds ? ` ≥ ${draft.holdAbove} % ${draft.holdSeconds} s max` : ""}${draft.maxDeg ? ` ≤ ${draft.maxDeg} °/s` : ""}${draft.steady ? ` ${t.steadyShort} ${draft.steady} s` : ""}${draft.allow.length ? ` ${t.allowOnly} ${draft.allow.map((k) => t.capabilityKinds[k as keyof typeof t.capabilityKinds]).join(", ")}` : ""}${draft.forOrigins.length || draft.forRoles.length ? ` (${[...draft.forOrigins.map((o) => t.origins[o as keyof typeof t.origins]), ...draft.forRoles.map((id) => roles.find((x) => x.id === id)?.name ?? id)].join(", ")})` : ""}`;
    const rule = {
      id: uniqueId(slug(name, "regle"), all.map((r) => r.id)),
      name,
      level: draft.level,
      scope: draft.scope === "all" || !draft.scopeValue ? {} : { [draft.scope]: draft.scopeValue },
      target,
      ...(draft.min ? { min: toDmx(draft.min) } : {}),
      ...(draft.max ? { max: toDmx(draft.max) } : {}),
      ...(draft.maxHz ? { maxHz: Number(draft.maxHz) } : {}),
      ...(draft.holdAbove && draft.holdSeconds ? { hold: { above: Math.max(1, toDmx(draft.holdAbove) ?? 1), seconds: Number(draft.holdSeconds) } } : {}),
      ...(draft.maxDeg ? { maxDegPerSecond: Number(draft.maxDeg) } : {}),
      ...(draft.steady ? { steadySeconds: Number(draft.steady) } : {}),
      ...(draft.allow.length ? { allowCapabilities: draft.allow } : {}),
      ...(draft.onViolation !== "clamp" ? { onViolation: draft.onViolation } : {}),
      ...(draft.forOrigins.length || draft.forRoles.length ? { appliesTo: { ...(draft.forOrigins.length ? { origins: draft.forOrigins } : {}), ...(draft.forRoles.length ? { roles: draft.forRoles } : {}) } } : {}),
      ...(draft.forbid.length ? { forbidTags: draft.forbid } : {}),
      locked: draft.locked,
      ...(draft.program ? { program: draft.program } : {}),
    };
    void cmd("rule.put", { where: draft.level === "show" ? "show" : "venue", rule })
      .then(() => setDraft({ ...draft, name: "", min: "", max: "", maxHz: "", holdAbove: "", holdSeconds: "", maxDeg: "", steady: "", allow: [], onViolation: "clamp", forOrigins: [], forRoles: [], forbid: [] }))
      .catch((e: Error) => onError(e.message));
  };

  return (
    <div className="rules-panel">
      <p className="hint">{t.rulesHelp}</p>
      <h3>{t.programs}</h3>
      <p className="hint">{t.programsHelp}</p>
      <table className="rules programs">
        <tbody>
          {programs.programs.map((p) => (
            <tr key={p.id} className={programs.active === p.id ? "active" : ""}>
              <td>
                {p.name} {programs.active === p.id && <span className="badge standby">{t.programActive}</span>}
              </td>
              <td>
                <small>{p.programChange !== undefined ? `PC #${p.programChange + 1} · ${t.midiChannel} ${p.channel}` : "—"}</small>
              </td>
              <td>
                {programs.active === p.id ? (
                  <button onClick={() => void cmd("program.select", { id: null }).catch((e: Error) => onError(e.message))}>{t.programOff}</button>
                ) : (
                  <button onClick={() => void cmd("program.select", { id: p.id }).catch((e: Error) => onError(e.message))}>{t.programOn}</button>
                )}
              </td>
              <td>
                <button className="ghost" aria-label={`${t.delete} ${p.name}`} onClick={() => void cmd("program.delete", { id: p.id }).catch((e: Error) => onError(e.message))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fields">
        <label className="field">
          <span>{t.name}</span>
          <input aria-label={t.programName} value={progDraft.name} onChange={(e) => setProgDraft({ ...progDraft, name: e.target.value })} />
        </label>
        <label className="field">
          <span>{t.programNumber}</span>
          <input type="number" min={1} max={128} aria-label={t.programNumber} value={progDraft.pc} onChange={(e) => setProgDraft({ ...progDraft, pc: e.target.value })} />
        </label>
        <label className="field">
          <span>{t.midiChannel}</span>
          <input type="number" min={1} max={16} value={progDraft.channel} onChange={(e) => setProgDraft({ ...progDraft, channel: e.target.value })} />
        </label>
        <button
          disabled={!progDraft.name.trim()}
          onClick={() =>
            void cmd("program.put", {
              program: { id: uniqueId(slug(progDraft.name, "programme"), programs.programs.map((p) => p.id)), name: progDraft.name, channel: Number(progDraft.channel) || 1, ...(progDraft.pc ? { programChange: Number(progDraft.pc) - 1 } : {}) },
            })
              .then(() => setProgDraft({ name: "", pc: "", channel: progDraft.channel }))
              .catch((e: Error) => onError(e.message))
          }
        >
          + {t.addProgram}
        </button>
      </div>

      <div className="row">
        <button
          className="ghost"
          onClick={() =>
            void cmd<{ written: { clip: string; file: string }[]; skipped: string[] }>("export.ableton.programs")
              .then((r) => onError(`${t.clipsWritten} : ${r.written.map((w) => w.file).join(", ") || "—"}${r.skipped.length ? ` · ${r.skipped.join(" · ")}` : ""}`))
              .catch((e: Error) => onError(e.message))
          }
        >
          ⤓ {t.exportClips}
        </button>
      </div>

      <h3>{t.rulesList}</h3>
      <table className="rules">
        <tbody>
          {all.map((r) => (
            <tr key={`${r.where}-${r.id}`}>
              <td>
                {r.name || r.id} {r.locked && <span className="badge conflict">{t.locked}</span>} {r.program && <span className="badge standby">{programs.programs.find((p) => p.id === r.program)?.name ?? r.program}</span>}
              </td>
              <td>
                <small>
                  {t.ruleLevels[r.level]} · {scopeText(r)} · {targetText(r)}
                </small>
              </td>
              <td>
                {r.min !== undefined && `min ${pct(r.min)} `}
                {r.max !== undefined && `max ${pct(r.max)} `}
                {r.maxHz !== undefined && `≤ ${r.maxHz} Hz `}
                {r.hold && `≥ ${pct(r.hold.above)} ${r.hold.seconds} s max `}
                {r.maxDegPerSecond !== undefined && `≤ ${r.maxDegPerSecond} °/s `}
                {r.steadySeconds !== undefined && `${t.steadyShort} ${r.steadySeconds} s `}
                {r.allowCapabilities?.length ? `${t.allowOnly} ${r.allowCapabilities.map((k) => t.capabilityKinds[k as keyof typeof t.capabilityKinds] ?? k).join(", ")} ` : ""}
                {r.onViolation && r.onViolation !== "clamp" && <span className="badge conflict">{t.onViolations[r.onViolation]}</span>}
                {r.appliesTo && (
                  <span className="badge">
                    {t.forCallers} {[...(r.appliesTo.origins ?? []).map((o) => t.origins[o as keyof typeof t.origins] ?? o), ...(r.appliesTo.roles ?? []).map((id) => roles.find((x) => x.id === id)?.name ?? id)].join(", ")}
                  </span>
                )}
                {r.forbidTags?.length ? `${t.forbidden} : ${r.forbidTags.map((x) => t.ruleTags[x as keyof typeof t.ruleTags] ?? x).join(", ")}` : ""}
              </td>
              <td>
                <button className="ghost" aria-label={`${t.delete} ${r.name || r.id}`} onClick={() => void cmd("rule.delete", { where: r.where, id: r.id }).catch((e: Error) => onError(e.message))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="fields rule-form">
        <label className="field">
          <span>{t.ruleLevel}</span>
          <select value={draft.level} onChange={(e) => setDraft({ ...draft, level: e.target.value as Rule["level"] })}>
            {(["type", "venue", "show"] as const).map((l) => (
              <option key={l} value={l}>
                {t.ruleLevels[l]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.ruleScope}</span>
          <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value, scopeValue: "" })}>
            <option value="all">{t.everything}</option>
            <option value="model">{t.model}</option>
            <option value="fixture">{t.fixture}</option>
            <option value="zone">{t.zone}</option>
          </select>
        </label>
        {draft.scope !== "all" && (
          <label className="field">
            <span>&nbsp;</span>
            <select aria-label={t.ruleScope} value={draft.scopeValue} onChange={(e) => setDraft({ ...draft, scopeValue: e.target.value })}>
              <option value="">—</option>
              {draft.scope === "model" && models.map((m) => <option key={m}>{m}</option>)}
              {draft.scope === "fixture" &&
                fixtures.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              {draft.scope === "zone" &&
                zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t.ruleTarget}</span>
          <select value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })}>
            {Object.keys(TARGETS).map((k) => (
              <option key={k} value={k}>
                {t.ruleTargets[k as keyof typeof t.ruleTargets]}
              </option>
            ))}
            <option value="channel">{t.namedChannel}</option>
          </select>
        </label>
        {draft.target === "channel" && (
          <label className="field">
            <span>{t.channelName}</span>
            <input value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value })} />
          </label>
        )}
        {(["min", "max"] as const).map((k) => (
          <label key={k} className="field">
            <span>{k} %</span>
            <input type="number" min={0} max={100} aria-label={`${k} %`} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          </label>
        ))}
        <label className="field" title={t.holdHint}>
          <span>{t.holdAbove}</span>
          <input type="number" min={1} max={100} aria-label={t.holdAbove} value={draft.holdAbove} onChange={(e) => setDraft({ ...draft, holdAbove: e.target.value })} />
        </label>
        <label className="field" title={t.holdHint}>
          <span>{t.holdSeconds}</span>
          <input type="number" min={0.5} max={600} step={0.5} aria-label={t.holdSeconds} value={draft.holdSeconds} onChange={(e) => setDraft({ ...draft, holdSeconds: e.target.value })} />
        </label>
        <label className="field" title={t.maxDegHint}>
          <span>{t.maxDeg}</span>
          <input type="number" min={1} max={10000} aria-label={t.maxDeg} value={draft.maxDeg} onChange={(e) => setDraft({ ...draft, maxDeg: e.target.value })} />
        </label>
        <label className="field" title={t.steadyHint}>
          <span>{t.steady}</span>
          <input type="number" min={0.5} max={600} step={0.5} aria-label={t.steady} value={draft.steady} onChange={(e) => setDraft({ ...draft, steady: e.target.value })} />
        </label>
        <label className="field" title={t.maxHzHint}>
          <span>{t.maxHz}</span>
          <input type="number" min={0.1} max={100} step={0.5} aria-label={t.maxHz} value={draft.maxHz} onChange={(e) => setDraft({ ...draft, maxHz: e.target.value })} />
        </label>
        <fieldset className="checklist">
          <legend>{t.forbidden}</legend>
          {TAGS.map((tag) => (
            <label key={tag} className="row">
              <input type="checkbox" checked={draft.forbid.includes(tag)} onChange={(e) => setDraft({ ...draft, forbid: e.target.checked ? [...draft.forbid, tag] : draft.forbid.filter((x) => x !== tag) })} />
              {t.ruleTags[tag]}
            </label>
          ))}
        </fieldset>
        <fieldset className="checklist" title={t.allowOnlyHint}>
          <legend>{t.allowOnly}</legend>
          {KINDS.map((k) => (
            <label key={k} className="row">
              <input type="checkbox" checked={draft.allow.includes(k)} onChange={(e) => setDraft({ ...draft, allow: e.target.checked ? [...draft.allow, k] : draft.allow.filter((x) => x !== k) })} />
              {t.capabilityKinds[k]}
            </label>
          ))}
        </fieldset>
        <fieldset className="checklist" title={t.forCallersHint}>
          <legend>{t.forCallers}</legend>
          {ORIGINS.map((o) => (
            <label key={o} className="row">
              <input type="checkbox" checked={draft.forOrigins.includes(o)} onChange={(e) => setDraft({ ...draft, forOrigins: e.target.checked ? [...draft.forOrigins, o] : draft.forOrigins.filter((x) => x !== o) })} />
              {t.origins[o]}
            </label>
          ))}
          {roles.map((r) => (
            <label key={r.id} className="row">
              <input type="checkbox" checked={draft.forRoles.includes(r.id)} onChange={(e) => setDraft({ ...draft, forRoles: e.target.checked ? [...draft.forRoles, r.id] : draft.forRoles.filter((x) => x !== r.id) })} />
              {r.name}
            </label>
          ))}
        </fieldset>
        <label className="field" title={t.onViolationHint}>
          <span>{t.onViolationLabel}</span>
          <select aria-label={t.onViolationLabel} value={draft.onViolation} onChange={(e) => setDraft({ ...draft, onViolation: e.target.value })}>
            {(["clamp", "confirm", "reject"] as const).map((v) => (
              <option key={v} value={v}>
                {t.onViolations[v]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.programLabel}</span>
          <select aria-label={t.programLabel} value={draft.program} onChange={(e) => setDraft({ ...draft, program: e.target.value })}>
            <option value="">{t.always}</option>
            {programs.programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.locked}</span>
          <input type="checkbox" checked={draft.locked} onChange={(e) => setDraft({ ...draft, locked: e.target.checked })} />
        </label>
        <label className="field">
          <span>{t.name}</span>
          <input placeholder={t.optional} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <button className="primary" disabled={!draft.min && !draft.max && !draft.maxHz && !(draft.holdAbove && draft.holdSeconds) && !draft.maxDeg && !draft.steady && !draft.allow.length && !draft.forbid.length} onClick={add}>
          + {t.addRule}
        </button>
      </div>

      <h3>{t.effectiveRules}</h3>
      <select aria-label={t.effectiveRules} value={inspect} onChange={(e) => setInspect(e.target.value)}>
        <option value="">—</option>
        {fixtures.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {inspect && (
        <table className="rules effective">
          <tbody>
            {effective.length === 0 && (
              <tr>
                <td className="hint">{t.noRule}</td>
              </tr>
            )}
            {effective.map((e) => (
              <tr key={e.dmx}>
                <td>
                  {e.channel} <small>(DMX {e.dmx})</small>
                </td>
                <td>
                  {e.min !== undefined && `min ${pct(e.min)} `}
                  {e.max !== undefined && `max ${pct(e.max)} `}
                  {e.maxHz !== undefined && `≤ ${e.maxHz} Hz `}
                  {e.forbidTags?.length ? `${t.forbidden} : ${e.forbidTags.join(", ")}` : ""}
                </td>
                <td>
                  <small>
                    {Object.entries(e.from)
                      .map(([k, v]) => `${k} ← ${v}`)
                      .join(" · ")}
                    {e.locked.length ? ` · ${t.locked} : ${e.locked.join(", ")}` : ""}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rules.clamps.length > 0 && (
        <p className="hint">
          {t.lastClamps} : {rules.clamps.slice(0, 6).map((c) => `${c.fixture}/${c.channel} ${c.from}→${c.to}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

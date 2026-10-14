/**
 * Rules and limits (docs/specs/rules-limits.md): list, create (level, scope, target, min/max,
 * forbidden modes, locked), the effective rule of each channel of a fixture with its provenance,
 * and the values the rules moved on the last frame. Values are shown in % of the DMX range.
 */
import { useCallback, useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
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
  forbidTags?: string[];
  locked: boolean;
}
interface Effective {
  channel: string;
  dmx: number;
  attribute: string;
  min?: number;
  max?: number;
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
  all: {},
};
const TAGS = ["soundActive", "autoProgram", "builtinMacro", "strobe", "reset", "uv"] as const;
const pct = (v?: number) => (v === undefined ? "" : `${Math.round((v / 255) * 100)} %`);
const toDmx = (p: string) => (p === "" ? undefined : Math.round((Number(p) / 100) * 255));

export function RulesPanel({ fixtures, zones, onError }: { fixtures: Named[]; zones: Named[]; onError: (msg: string) => void }) {
  const t = useT();
  const [rules, setRules] = useState<{ venue: Rule[]; show: Rule[]; clamps: { fixture: string; channel: string; from: number; to: number; rule: string }[] }>({ venue: [], show: [], clamps: [] });
  const [draft, setDraft] = useState({ name: "", level: "show" as Rule["level"], scope: "all", scopeValue: "", target: "intensity", channel: "", min: "", max: "", forbid: [] as string[], locked: false });
  const [inspect, setInspect] = useState("");
  const [effective, setEffective] = useState<Effective[]>([]);

  const refresh = useCallback(() => {
    void cmd<typeof rules>("rule.list").then(setRules).catch((e: Error) => onError(e.message));
  }, [onError]);
  useEffect(refresh, [refresh]);
  useCommandEvents(["rule."], refresh);
  useEffect(() => {
    if (inspect) void cmd<Effective[]>("rule.effective", { fixture: inspect }).then(setEffective).catch((e: Error) => onError(e.message));
    else setEffective([]);
  }, [inspect, rules, onError]);

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
    const name = draft.name || `${t.ruleTargets[draft.target as keyof typeof t.ruleTargets] ?? draft.channel}${draft.max ? ` max ${draft.max} %` : ""}${draft.min ? ` min ${draft.min} %` : ""}`;
    const rule = {
      id: uniqueId(slug(name, "regle"), all.map((r) => r.id)),
      name,
      level: draft.level,
      scope: draft.scope === "all" || !draft.scopeValue ? {} : { [draft.scope]: draft.scopeValue },
      target,
      ...(draft.min ? { min: toDmx(draft.min) } : {}),
      ...(draft.max ? { max: toDmx(draft.max) } : {}),
      ...(draft.forbid.length ? { forbidTags: draft.forbid } : {}),
      locked: draft.locked,
    };
    void cmd("rule.put", { where: draft.level === "show" ? "show" : "venue", rule })
      .then(() => setDraft({ ...draft, name: "", min: "", max: "", forbid: [] }))
      .catch((e: Error) => onError(e.message));
  };

  return (
    <div className="rules-panel">
      <p className="hint">{t.rulesHelp}</p>
      <table className="rules">
        <tbody>
          {all.map((r) => (
            <tr key={`${r.where}-${r.id}`}>
              <td>
                {r.name || r.id} {r.locked && <span className="badge conflict">{t.locked}</span>}
              </td>
              <td>
                <small>
                  {t.ruleLevels[r.level]} · {scopeText(r)} · {targetText(r)}
                </small>
              </td>
              <td>
                {r.min !== undefined && `min ${pct(r.min)} `}
                {r.max !== undefined && `max ${pct(r.max)} `}
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
        <fieldset className="checklist">
          <legend>{t.forbidden}</legend>
          {TAGS.map((tag) => (
            <label key={tag} className="row">
              <input type="checkbox" checked={draft.forbid.includes(tag)} onChange={(e) => setDraft({ ...draft, forbid: e.target.checked ? [...draft.forbid, tag] : draft.forbid.filter((x) => x !== tag) })} />
              {t.ruleTags[tag]}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>{t.locked}</span>
          <input type="checkbox" checked={draft.locked} onChange={(e) => setDraft({ ...draft, locked: e.target.checked })} />
        </label>
        <label className="field">
          <span>{t.name}</span>
          <input placeholder={t.optional} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <button className="primary" disabled={!draft.min && !draft.max && !draft.forbid.length} onClick={add}>
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

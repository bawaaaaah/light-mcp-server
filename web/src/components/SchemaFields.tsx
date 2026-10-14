/**
 * Form fields generated from a JSON schema object (technique parameters from `look.techniques`):
 * colours, colour lists, numbers, booleans, enums, line lists (masks) and letter maps. The server
 * stays the single source of truth: a new technique parameter shows up without UI code.
 */
import { useT } from "../App";

export interface JsonSchema {
  type?: string;
  const?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  default?: unknown;
  items?: JsonSchema | JsonSchema[];
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema | boolean;
  required?: string[];
}

type Values = Record<string, unknown>;

const COLOR_KEYS = new Set(["color", "base", "flash"]);
const FALLBACK_COLORS = ["#ff0000", "#0000ff", "#00ff00", "#ffffff", "#ff8000", "#ff00ff"];

/** "#ff960f+w40" → { hex: "#ff960f", suffix: "+w40" } */
const splitColor = (v: string) => {
  const m = /^(#[0-9a-f]{6})(.*)$/i.exec(v);
  return m ? { hex: m[1]!.toLowerCase(), suffix: m[2]! } : { hex: "#ffffff", suffix: "" };
};

export function ColorInput({ value, onChange, title }: { value: string; onChange: (v: string) => void; title?: string }) {
  const { hex, suffix } = splitColor(value);
  return <input type="color" className="swatch" title={title ?? value} value={hex} onChange={(e) => onChange(e.target.value + suffix)} />;
}

const isColorList = (key: string, s: JsonSchema) => key === "colors" && s.type === "array";
const isLines = (s: JsonSchema) => s.type === "array" && !Array.isArray(s.items) && (s.items as JsonSchema | undefined)?.type === "string";
const isMap = (s: JsonSchema) => s.type === "object" && typeof s.additionalProperties === "object";

/** Initial values for a schema, reusing what fits from the previous values (colours above all). */
export function defaultsFor(schema: JsonSchema, previous: Values, cells: number): Values {
  const prevColors = [
    ...(Array.isArray(previous.colors) ? (previous.colors as string[]) : []),
    ...["color", "base", "flash"].map((k) => previous[k]).filter((v): v is string => typeof v === "string"),
  ];
  const colors = [...new Set([...prevColors, ...FALLBACK_COLORS])];
  const out: Values = {};
  for (const [key, s] of Object.entries(schema.properties ?? {})) {
    if (s.const !== undefined) out[key] = s.const;
    else if (key in previous && key !== "kind" && typeof previous[key] === typeof s.default) out[key] = previous[key];
    else if (s.default !== undefined) out[key] = s.default;
    else if (COLOR_KEYS.has(key)) out[key] = colors[0];
    else if (isColorList(key, s)) {
      const n = Math.max(s.minItems ?? 1, Math.min(prevColors.length || 2, s.maxItems ?? 20));
      out[key] = colors.slice(0, n);
    } else if (key === "masks") out[key] = ["#-#-", "-#-#"];
    else if (key === "patterns") out[key] = ["AB", "BA"];
    else if (key === "map") out[key] = { A: colors[0], B: colors[1] };
    else if (key === "steps" && s.type === "array") out[key] = [Array.from({ length: cells }, () => colors[0])];
  }
  return out;
}

export function SchemaFields({ schema, values, onChange, skip = [] }: { schema: JsonSchema; values: Values; onChange: (v: Values) => void; skip?: string[] }) {
  const t = useT();
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v });
  const label = (key: string) => (t.fields as Record<string, string>)[key] ?? key;

  return (
    <div className="fields">
      {Object.entries(schema.properties ?? {}).map(([key, s]) => {
        if (s.const !== undefined || skip.includes(key)) return null;
        const v = values[key];
        let field: React.ReactNode;
        if (COLOR_KEYS.has(key)) field = <ColorInput value={String(v ?? "#ffffff")} onChange={(x) => set(key, x)} />;
        else if (isColorList(key, s)) {
          const list = (v as string[] | undefined) ?? [];
          const max = s.maxItems ?? 20;
          const min = s.minItems ?? 1;
          field = (
            <span className="colors">
              {list.map((c, i) => (
                <ColorInput key={i} value={c} onChange={(x) => set(key, list.map((y, j) => (j === i ? x : y)))} />
              ))}
              {list.length < max && (
                <button className="ghost" onClick={() => set(key, [...list, FALLBACK_COLORS[list.length % FALLBACK_COLORS.length]])}>
                  +
                </button>
              )}
              {list.length > min && (
                <button className="ghost" onClick={() => set(key, list.slice(0, -1))}>
                  −
                </button>
              )}
            </span>
          );
        } else if (isLines(s))
          field = <textarea rows={Math.min(8, Math.max(2, ((v as string[] | undefined) ?? []).length))} value={((v as string[] | undefined) ?? []).join("\n")} onChange={(e) => set(key, e.target.value.split("\n"))} onBlur={(e) => set(key, e.target.value.split("\n").filter((l) => l.trim()))} />;
        else if (isMap(s)) {
          const map = (v as Record<string, string | null> | undefined) ?? {};
          field = (
            <span className="colors">
              {Object.entries(map).map(([letter, c]) => (
                <span key={letter} className="letter">
                  {letter}
                  {c === null ? (
                    <button className="ghost" title={t.off} onClick={() => set(key, { ...map, [letter]: "#ffffff" })}>
                      ∅
                    </button>
                  ) : (
                    <ColorInput value={c} onChange={(x) => set(key, { ...map, [letter]: x })} />
                  )}
                </span>
              ))}
              <button
                className="ghost"
                onClick={() => {
                  const next = String.fromCharCode(65 + Object.keys(map).length);
                  set(key, { ...map, [next]: null });
                }}
              >
                +
              </button>
            </span>
          );
        } else if (s.enum)
          field = (
            <select value={String(v ?? s.default ?? "")} onChange={(e) => set(key, e.target.value)}>
              {s.enum.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          );
        else if (s.type === "boolean") field = <input type="checkbox" checked={Boolean(v)} onChange={(e) => set(key, e.target.checked)} />;
        else if (s.type === "number" || s.type === "integer") {
          const unit = s.type === "number" && s.minimum === 0 && s.maximum === 1;
          field = (
            <input
              type="number"
              min={s.minimum ?? s.exclusiveMinimum}
              max={s.maximum}
              step={s.type === "integer" ? 1 : unit ? 0.05 : 0.1}
              value={v === undefined ? "" : Number(v)}
              onChange={(e) => set(key, e.target.value === "" ? undefined : Number(e.target.value))}
            />
          );
        } else return null; // other shapes have their own editor (e.g. « pas » steps)
        return (
          <label key={key} className="field">
            <span>{label(key)}</span>
            {field}
          </label>
        );
      })}
    </div>
  );
}

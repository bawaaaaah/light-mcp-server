/**
 * Guided calibration of a moving head (docs/specs/venue-fixtures-stage.md, « Lyres »): aim it by
 * hand at 2–3 known floor marks, record each one, then solve its yaw, tilt offset and inversions.
 */
import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { XyPad } from "./XyPad";

interface Head {
  id: string;
  name: string;
}
interface Result {
  yaw: number;
  tiltOffset: number;
  invertPan: boolean;
  invertTilt: boolean;
  errorDeg: number;
  errors: number[];
  applied: boolean;
}

export function Calibration({ zones, placed, onError, onApplied }: { zones: { id: string; name: string }[]; placed: Set<string>; onError: (msg: string) => void; onApplied: () => void }) {
  const t = useT();
  const [heads, setHeads] = useState<Head[]>([]);
  const [head, setHead] = useState("");
  const [zone, setZone] = useState("");
  const [xy, setXy] = useState({ x: 0, y: 0 });
  const [marks, setMarks] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  const placedKey = [...placed].sort().join(",");
  useEffect(() => {
    void cmd<Head[]>("position.list").then((h) => {
      const usable = h.filter((x) => placed.has(x.id));
      setHeads(usable);
      setHead((cur) => (usable.some((x) => x.id === cur) ? cur : (usable[0]?.id ?? "")));
    });
    // the set is rebuilt on every render of the page: its content is the dependency
  }, [placedKey]);
  useEffect(() => {
    if (head) void cmd<unknown[]>("calibration.list", { fixture: head }).then((l) => setMarks(l.length));
    setResult(null);
  }, [head]);

  if (!heads.length) return <p className="hint">{t.calibrationNone}</p>;
  const fail = (e: Error) => onError(e.message);
  return (
    <div className="calibration">
      <p className="hint">{t.calibrationHelp}</p>
      <div className="fields">
        <label className="field">
          <span>{t.heads}</span>
          <select value={head} onChange={(e) => setHead(e.target.value)}>
            {heads.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.calibrationMark}</span>
          <select value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">{t.calibrationPoint}</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </label>
        {!zone &&
          (["x", "y"] as const).map((k) => (
            <label key={k} className="field">
              <span>{k} (m)</span>
              <input type="number" step={0.1} value={xy[k]} onChange={(e) => setXy({ ...xy, [k]: Number(e.target.value) })} />
            </label>
          ))}
      </div>
      <div className="calibration-pad">
        <XyPad fixture={head} label={heads.find((h) => h.id === head)?.name} onError={onError} />
      </div>
      <div className="row actions">
        <button
          onClick={() =>
            void cmd<{ samples: number }>("calibration.record", { fixture: head, ...(zone ? { zone } : { point: { x: xy.x, y: xy.y, z: 0 } }) })
              .then((r) => setMarks(r.samples))
              .catch(fail)
          }
        >
          {t.calibrationRecord} ({marks})
        </button>
        <button disabled={marks < 2} onClick={() => void cmd<Result>("calibration.solve", { fixture: head }).then(setResult).catch(fail)}>
          {t.calibrationSolve}
        </button>
        <button className="ghost" onClick={() => void cmd("calibration.clear", { fixture: head }).then(() => (setMarks(0), setResult(null)))}>
          {t.calibrationClear}
        </button>
      </div>
      {result && (
        <div className="report">
          <p>
            yaw {result.yaw}° · tilt {result.tiltOffset > 0 ? "+" : ""}
            {result.tiltOffset}° · {result.invertPan ? t.panInverted : t.panNormal} · {result.invertTilt ? t.tiltInverted : t.tiltNormal}
          </p>
          <p className={result.errorDeg > 3 ? "error" : "hint"}>
            {t.calibrationError} : {result.errorDeg}° ({result.errors.join("°, ")}°){result.errorDeg > 3 ? ` — ${t.calibrationBad}` : ""}
          </p>
          <button
            className="primary"
            onClick={() =>
              (result.errorDeg <= 3 || confirm(`${t.calibrationBad}. ${t.calibrationApplyAnyway}`)) &&
              void cmd<Result>("calibration.solve", { fixture: head, apply: true })
                .then((r) => (setResult(r), setMarks(0), onApplied()))
                .catch(fail)
            }
          >
            {t.apply}
          </button>
          {result.applied && <span className="hint"> ✔</span>}
        </div>
      )}
    </div>
  );
}

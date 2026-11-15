/**
 * Why a head holds for a 3D target (T24), in the interface's language: the motion layer reports it outside any request,
 * so its message is French; the hold as data (`AxisReport.hold`) is said again here (the target pad, the XY pad).
 */
import type { Texts } from "./i18n";
import { quoted } from "./typography";
import type { AxisReport } from "../../src/plugins/light/show/motion-report";

export function holdText(t: Texts, a: Pick<AxisReport, "error" | "hold">): string {
  const h = a.hold;
  const w = t.targets;
  if (!h) return a.error ?? "";
  switch (h.reason) {
    case "no-aim":
      return w.holdNoAim.replace("{zone}", () => quoted(t, h.zone ?? ""));
    case "no-position":
      return w.holdNoPosition;
    case "out-of-reach":
      if (h.reach && !h.onFixture && h.limited) return w.holdBeyondStops.replace("{pan}", () => String(h.reach!.pan)).replace("{tilt}", () => String(h.reach!.tilt));
      return h.reach && !h.onFixture ? w.holdOutOfReach.replace("{pan}", () => String(h.reach!.pan)).replace("{tilt}", () => String(h.reach!.tilt)) : w.holdOnFixture;
  }
}

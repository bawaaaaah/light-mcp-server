/** Widget colours (docs/specs/ui-dashboards.md): ready-made swatches and the text that reads on them. */

/** Distinct on a dark stage-side screen, and named so the menu can say them. */
export const SWATCHES: [name: string, hex: string][] = [
  ["rouge", "#ef4444"],
  ["orange", "#f97316"],
  ["ambre", "#f59e0b"],
  ["jaune", "#eab308"],
  ["vert", "#22c55e"],
  ["turquoise", "#14b8a6"],
  ["cyan", "#06b6d4"],
  ["bleu", "#3b82f6"],
  ["indigo", "#6366f1"],
  ["violet", "#a855f7"],
  ["rose", "#ec4899"],
  ["blanc", "#f5f5f4"],
];

/** Black or white, whichever reads better on `hex` (relative luminance). */
export function textOn(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.36 ? "#111111" : "#ffffff";
}

export const isHex = (c: string | undefined): c is string => Boolean(c && /^#[0-9a-f]{6}$/i.test(c));

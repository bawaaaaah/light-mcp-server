/**
 * Modular dashboards (docs/specs/ui-dashboards.md): a grid of widgets bound to looks, groups,
 * songs or actions — never to DMX channels — stored in the show and shared by every screen.
 */
import { z } from "zod";
import type { Group, Look } from "../show/model.js";

export const WidgetSchema = z.object({
  id: z.string(),
  kind: z.enum(["look", "group-fader", "panic", "blackout", "tap", "section", "song-nav", "label", "stop-all", "xy", "preview"]),
  /** Grid position (columns × rows of the dashboard). */
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).default(2),
  h: z.number().int().min(1).default(1),
  /** Target: look id, group id (faders; XY pad: its moving heads, none = all), "song:section", or label text. */
  target: z.string().optional(),
  label: z.string().optional(),
  mode: z.enum(["trigger", "latch", "momentary"]).optional(),
  color: z.string().optional(),
  notes: z.string().optional(),
});
export type Widget = z.infer<typeof WidgetSchema>;

export const DashboardSchema = z.object({
  id: z.string(),
  name: z.string(),
  columns: z.number().int().min(4).max(24).default(12),
  widgets: z.array(WidgetSchema).default([]),
  /** Roles allowed to see it; absent = everyone. */
  roles: z.array(z.string()).optional(),
  notes: z.string().optional(),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

/** A first dashboard built from the show: safety bar, one row per exclusive group, then faders (and an XY pad for moving heads). */
export function defaultDashboard(looks: Look[], groups: Group[], movingHeads = false): Dashboard {
  const widgets: Widget[] = [
    { id: "panic", kind: "panic", x: 0, y: 0, w: 3, h: 1 },
    { id: "blackout", kind: "blackout", x: 3, y: 0, w: 2, h: 1 },
    { id: "tap", kind: "tap", x: 5, y: 0, w: 2, h: 1 },
    { id: "stop-all", kind: "stop-all", x: 7, y: 0, w: 2, h: 1 },
    { id: "song-nav", kind: "song-nav", x: 9, y: 0, w: 3, h: 1 },
  ];
  let y = 1;
  const placed = new Set<string>();
  const row = (title: string, ids: string[]) => {
    widgets.push({ id: `label-${y}`, kind: "label", x: 0, y, w: 12, h: 1, label: title });
    y += 1;
    ids.forEach((id, i) => {
      placed.add(id);
      widgets.push({ id: `look-${id}`, kind: "look", target: id, x: (i % 6) * 2, y: y + Math.floor(i / 6), w: 2, h: 1 });
    });
    y += Math.ceil(ids.length / 6);
  };
  for (const g of groups.filter((x) => x.exclusive)) row(g.name, g.members.looks.filter((id) => looks.some((l) => l.id === id)));
  const rest = looks.filter((l) => !placed.has(l.id)).map((l) => l.id);
  if (rest.length) row("Looks", rest);
  groups
    .filter((g) => g.master)
    .forEach((g, i) => widgets.push({ id: `fader-${g.id}`, kind: "group-fader", target: g.id, x: i % 12, y: y + Math.floor(i / 12) * 4, w: 1, h: 4 }));
  if (movingHeads) {
    const faders = groups.filter((g) => g.master).length;
    widgets.push({ id: "xy", kind: "xy", x: faders > 8 ? 0 : 9, y: faders > 8 ? y + Math.ceil(faders / 12) * 4 : y, w: 3, h: 4, label: "Lyres" });
  }
  return { id: "principal", name: "Principal", columns: 12, widgets };
}

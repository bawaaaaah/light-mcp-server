/**
 * Dashboards: list and generate.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { DashboardSchema, defaultDashboard } from "../dashboards/dashboards.js";
import type { ShowCommandScope } from "./show-command-scope.js";

export function registerDashboardCommands(common: ShowCommandScope): void {
  const { reg, show, idSchema, dashboards } = common;
  // ---- dashboards
  reg.register({
    name: "dashboard.list",
    title: "Dashboards",
    titleEn: "Dashboards",
    description: "Dashboards of the show (grid of widgets bound to looks, groups, songs, actions). Creates a default one from the show when none exists.",
    right: "dashboards:view",
    readOnly: true,
    profiles: ["design", "live"],
    schema: z.object({}),
    run: () => {
      if (dashboards.list().length === 0) return [defaultDashboard(show.looks.list(), show.groups.list(), show.movingHeads().length > 0, show.faders.list())];
      return dashboards.list();
    },
  });
  reg.register({ name: "dashboard.put", title: "Dashboard", titleEn: "Dashboard", hints: "I", changes: ["dashboards"], description: "Creates or updates a dashboard (columns, widgets with grid position, target, mode, roles allowed).", right: "show:write", profiles: ["design"], schema: z.object({ dashboard: DashboardSchema }), run: ({ dashboard }) => dashboards.put(dashboard) });
  reg.register({ name: "dashboard.delete", title: "Supprimer un dashboard", titleEn: "Delete a dashboard", hints: "DI", changes: ["dashboards"], description: "Deletes a dashboard.", right: "show:write", profiles: ["design"], schema: idSchema, run: ({ id: i }) => ({ deleted: dashboards.delete(i) }) });
  reg.register({
    name: "dashboard.generate",
    title: "Générer un dashboard",
    titleEn: "Generate a dashboard",
    hints: "I",
    changes: ["dashboards"],
    description: "Builds a dashboard from the show (safety bar, one row of buttons per exclusive group, group faders) and saves it.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ id: z.string().default("principal"), name: z.string().default("Principal") }),
    run: ({ id: i, name }) => dashboards.put({ ...defaultDashboard(show.looks.list(), show.groups.list(), show.movingHeads().length > 0, show.faders.list()), id: i, name }),
  });
}

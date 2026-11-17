/**
 * The kinds of dashboard widget (docs/specs/ui-dashboards.md), in the order the dashboard editor's palette offers
 * them. One list for the server's schema and the web's palette and registry: a kind added here is validated, offered
 * and must be drawn. Pure, no import: the web imports it as it is.
 */
export const WIDGET_KINDS = ["look", "group-fader", "grand-master", "section", "snapshot", "panic", "blackout", "tap", "stop-all", "song-nav", "label", "xy", "target", "position", "motion-lock", "preview", "channel-fader", "colours", "zones"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

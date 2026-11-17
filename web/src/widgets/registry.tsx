/**
 * What draws each kind of dashboard widget (docs/specs/ui-dashboards.md). A kind whose control already has its own
 * component (XY pad, target pad, colours, zones, motion lock, position button, stage) is drawn by it here; the others
 * have their module in this folder. Sizes, target lists and press traits are in dashboard-layout.ts, pure.
 */
import type { ComponentType, ReactElement } from "react";
import { useT } from "../i18n-context";
import { XyPad } from "../components/XyPad";
import { TargetWidget } from "../components/TargetPad";
import { PositionButton } from "../components/PositionButton";
import { ColoursWidget } from "../components/ColoursWidget";
import { ZonesWidget } from "../components/ZonesWidget";
import { MotionLockButton } from "../components/MotionLockButton";
import { LiveStage } from "../components/StagePlan";
import type { WidgetKind } from "../dashboard-layout";
import type { WidgetEnv, WidgetProps } from "./env";
import { PanicWidget } from "./Panic";
import { BlackoutWidget } from "./Blackout";
import { TapWidget } from "./Tap";
import { SongNavWidget } from "./SongNav";
import { SectionWidget } from "./Section";
import { LookButtonWidget } from "./LookButton";
import { SnapshotWidget } from "./Snapshot";
import { ChannelFaderWidget } from "./ChannelFader";
import { GrandMasterWidget } from "./GrandMaster";
import { GroupFaderWidget } from "./GroupFader";

/** The widget's group (none: every head), its name as the label by default, and whether that group was deleted. */
const groupOf = (w: WidgetProps["w"], env: WidgetEnv) => ({
  group: w.target || undefined,
  label: w.label ?? env.groupById.get(w.target ?? "")?.name,
  groupDeleted: Boolean(w.target) && env.groupsRead && !env.groupById.has(w.target ?? ""),
});

function StopAllWidget({ env }: WidgetProps): ReactElement {
  const t = useT();
  return (
    <button className="fill" {...env.locked("commands:trigger")} onClick={() => void env.run("look.stopall")}>
      ■ {t.looks}
    </button>
  );
}

export const WIDGETS: Record<WidgetKind, ComponentType<WidgetProps>> = {
  label: ({ w }) => <div className="w-label">{w.label ?? w.target}</div>,
  panic: PanicWidget,
  blackout: BlackoutWidget,
  "stop-all": StopAllWidget,
  tap: TapWidget,
  "song-nav": SongNavWidget,
  section: SectionWidget,
  look: LookButtonWidget,
  snapshot: SnapshotWidget,
  preview: ({ env }) => (
    <div className="fill preview-widget">
      <LiveStage onError={env.onError} beamsShown={env.stageBeams} />
    </div>
  ),
  // « Figer les lyres » (T26): the top bar's button, placed and sized at will, optionally for one group
  // edit mode: `inert` guards the presses without disabling the buttons, so the widget is still dragged and selected
  "motion-lock": ({ w, env }) => {
    const { group, label, groupDeleted } = groupOf(w, env);
    return <MotionLockButton variant="widget" group={group} label={label} inert={env.edit} groupDeleted={groupDeleted} onError={env.onError} />;
  },
  // edit mode: `inert` guards the keys too (its chips, « Rendre la main »), the widget is still moved and selected
  xy: ({ w, env }) => <XyPad group={w.target || undefined} label={w.label} onError={env.onError} disabled={!env.may("commands:position")} compact zones={env.zoneChips} inert={env.edit} />,
  // a 3D target (T24): its pad, its Z fader and « Engager »; chosen in the widget's menu. Keyed by the target:
  // another target is another pad (its pending write goes out for the target it was made for)
  target: ({ w, env }) => <TargetWidget key={w.target ?? ""} id={w.target || undefined} label={w.label} stage={env.targetStage} onError={env.onError} disabled={!env.may("commands:position")} interactive={!env.edit} />,
  // a named position (T32): one button that recalls it, lit while its heads hold it
  position: ({ w, env }) => <PositionButton id={w.target || undefined} label={w.label} disabled={!env.may("commands:position")} inert={env.edit} />,
  // the show's favourite colours (T41): one button each, applied by hand to the widget's group (none: every fixture)
  colours: ({ w, env }) => {
    const { group, label } = groupOf(w, env);
    return <ColoursWidget group={group} label={label} disabled={!env.may("commands:trigger")} inert={env.edit} />;
  },
  // the aiming zones (T28): a press aims the widget's group (none: every head) there, by hand, until « Rendre la main »
  zones: ({ w, env }) => {
    const { group, label, groupDeleted } = groupOf(w, env);
    return <ZonesWidget group={group} label={label} zones={env.zoneChips} disabled={!env.may("commands:position")} inert={env.edit} groupDeleted={groupDeleted} />;
  },
  "channel-fader": ChannelFaderWidget,
  "grand-master": GrandMasterWidget,
  "group-fader": GroupFaderWidget,
};

/** A widget, drawn by its kind. */
export function WidgetView({ w, env }: WidgetProps): ReactElement | null {
  const View = WIDGETS[w.kind] as ComponentType<WidgetProps> | undefined; // a kind this page does not know: an empty cell
  return View ? <View w={w} env={env} /> : null;
}

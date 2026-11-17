import { lazy, Suspense, type ReactElement } from "react";
import { foldersOf, withParents } from "../../../src/plugins/light/show/folders.js";
import { Modal } from "./Modal";
import type { LookDraft } from "./LookEditor";
import type { GroupDraft } from "./GroupEditor";
import type { FaderDraft } from "./FaderEditor";
import type { AdvancedKind } from "./WidgetMenu";
// the editors only when one is opened from the Live: the Live page stays light to load
const LookEditor = lazy(() => import("./LookEditor").then((m) => ({ default: m.LookEditor })));
const GroupEditor = lazy(() => import("./GroupEditor").then((m) => ({ default: m.GroupEditor })));
const FaderEditor = lazy(() => import("./FaderEditor").then((m) => ({ default: m.FaderEditor })));

/**
 * The whole editor of what a widget drives — a look, a DCA, a channel fader — opened from its menu (« Avancé »), over
 * the dashboard. `looks`, `groups`, `faders`: the show's, whose ids are taken; `namedFolders`: the folders named ahead,
 * offered with the looks' own like the Show page does.
 */
export function AdvancedEditors({ look, group, fader, looks, groups, faders, namedFolders, onClose }: {
  look: LookDraft | null;
  group: GroupDraft | null;
  fader: FaderDraft | null;
  looks: { id: string; tags: string[] }[];
  groups: { id: string }[];
  faders: { id: string }[];
  namedFolders: string[];
  onClose: (kind: AdvancedKind) => void;
}): ReactElement {
  return (
    <>
      {group && (
        <Modal label={group.name}>
          <Suspense fallback={<p className="hint">…</p>}>
            <GroupEditor key={group.id} initial={group} existing={groups.map((g) => g.id)} onClose={() => onClose("group")} />
          </Suspense>
        </Modal>
      )}
      {fader && (
        <Modal label={fader.name}>
          <Suspense fallback={<p className="hint">…</p>}>
            <FaderEditor key={fader.id} initial={fader} existing={faders.map((f) => f.id)} onClose={() => onClose("fader")} />
          </Suspense>
        </Modal>
      )}
      {look && (
        <Modal label={look.name}>
          <Suspense fallback={<p className="hint">…</p>}>
            <LookEditor key={look.id} initial={look} existing={looks.map((l) => l.id)} folders={withParents([...foldersOf(looks), ...namedFolders])} onClose={() => onClose("look")} />
          </Suspense>
        </Modal>
      )}
    </>
  );
}

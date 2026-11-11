import { useCallback, useEffect, useId, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { quoted } from "../typography";

/** What venue.grouping.propose answers (src/plugins/light/venue/grouping.ts). */
interface Proposal {
  tags: { fixture: string; name: string; tag: string }[];
  groups: { tag: string; id: string; name: string; fixtures: string[]; names: string[]; complete?: { missing: string[] } }[];
  /** Existing groups a tag would change (show: another show on the same venue). */
  affected: { tag: string; id: string; name: string; joins: string[]; show?: string }[];
}

/**
 * Type groups, on proposal (« Vérifier le show »): a group per kind of fixture and the tags they lack.
 * Nothing is written without a click; the commands decide what is proposed, this only shows it, with
 * the fixtures it gathers and the existing groups a tag would change, before the click. `checked`
 * changes on each « Vérifier le show »: the proposal is read again then.
 */
export function TypeGroups({ checked, onError, onApplied }: { checked: unknown; onError: (message: string) => void; onApplied: () => Promise<unknown> }): ReactElement | null {
  const t = useT();
  const title = useId();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  /** Per kind: a live group by tag (the default) or a fixed list. */
  const [fixed, setFixed] = useState<Record<string, boolean>>({});
  /** The kind being applied: its buttons wait, a second click does not send twice. */
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => void cmd<Proposal>("venue.grouping.propose").then(setProposal, (e: Error) => onError(e.message)), [onError]);
  useEffect(load, [load, checked]);
  if (!proposal || (!proposal.tags.length && !proposal.groups.length)) return null;
  const apply = (tag: string, args: { tags?: string[]; groups?: { tag: string; live: boolean }[] }) => {
    setBusy(tag);
    void cmd("venue.grouping.apply", args)
      .then(
        // onApplied checks the show again, which changes `checked`: the proposal is read once, then;
        // when that check fails, the proposal is read here, never left as it was before the click
        () =>
          onApplied().catch((e: Error) => {
            onError(e.message);
            load();
          }),
        (e: Error) => onError(e.message),
      )
      .finally(() => setBusy(null));
  };
  /** The existing groups the tag of this kind would change, said before the click. */
  const affects = (tag: string) => {
    const list = proposal.affected.filter((a) => a.tag === tag);
    if (!list.length) return null;
    const groups = list.map((a) => `${quoted(t, a.name)}${a.show ? ` (${t.typeGroupOtherShow.replace("{show}", a.show)})` : ""} +${a.joins.length}`).join(", ");
    return <p className="warn">{t.typeGroupAffects.replace("{groups}", groups)}</p>;
  };
  // kinds whose fixtures lack their tag but that need no new group (one fixture, or a group already there)
  const tagOnly = [...new Set(proposal.tags.map((x) => x.tag))].filter((tag) => !proposal.groups.some((g) => g.tag === tag));
  return (
    <section className="type-groups" aria-labelledby={title}>
      <h3 id={title}>{t.typeGroups}</h3>
      <p className="hint">{t.typeGroupsHelp}</p>
      {proposal.groups.some((g) => !g.complete) && <p className="hint">{t.typeGroupLiveHelp}</p>}
      <ul>
        {proposal.groups.map((g) => {
          const live = !g.complete && !fixed[g.tag];
          return (
            <li key={g.tag}>
              <div className="row">
                <span className="name">{g.name}</span>
                <span className="hint">
                  {g.fixtures.length} {t.typeGroupFixtures}
                </span>
                {!g.complete && (
                  <label>
                    <input type="checkbox" checked={live} onChange={(e) => setFixed({ ...fixed, [g.tag]: !e.target.checked })} /> {t.typeGroupLive}
                  </label>
                )}
                <button disabled={busy !== null} aria-busy={busy === g.tag} onClick={() => apply(g.tag, { groups: [{ tag: g.tag, live }] })}>
                  {g.complete ? t.typeGroupComplete : t.typeGroupCreate}
                </button>
              </div>
              <p className="hint">
                {g.names.join(", ")}
                {g.complete && ` — ${t.typeGroupMissing.replace("{names}", g.complete.missing.join(", "))}`}
              </p>
              {live && affects(g.tag)}
            </li>
          );
        })}
        {tagOnly.map((tag) => {
          const tagged = proposal.tags.filter((x) => x.tag === tag);
          return (
            <li key={tag}>
              <div className="row">
                <button disabled={busy !== null} aria-busy={busy === tag} onClick={() => apply(tag, { tags: [tag] })}>
                  {t.typeTagsAdd.replace("{tag}", tag).replace("{n}", String(tagged.length))}
                </button>
              </div>
              <p className="hint">{tagged.map((x) => x.name).join(", ")}</p>
              {affects(tag)}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

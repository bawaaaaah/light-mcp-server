import { useCallback, useEffect, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";

/** What venue.grouping.propose answers (src/plugins/light/venue/grouping.ts). */
interface Proposal {
  tags: { fixture: string; name: string; tag: string }[];
  groups: { tag: string; id: string; name: string; fixtures: string[] }[];
}

/**
 * Type groups, on proposal (« Vérifier le show »): a group per kind of fixture and the tags they lack.
 * Nothing is written without a click; the commands decide what is proposed, this only shows it.
 */
export function TypeGroups({ onError, onApplied }: { onError: (message: string) => void; onApplied: () => void }): ReactElement | null {
  const t = useT();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  /** Per kind: a live group by tag (the default) or a fixed list. */
  const [fixed, setFixed] = useState<Record<string, boolean>>({});
  const load = useCallback(() => void cmd<Proposal>("venue.grouping.propose").then(setProposal, (e: Error) => onError(e.message)), [onError]);
  useEffect(load, [load]);
  if (!proposal || (!proposal.tags.length && !proposal.groups.length)) return null;
  const apply = (args: { tags?: string[]; groups?: { tag: string; live: boolean }[] }) =>
    void cmd("venue.grouping.apply", args).then(() => {
      load();
      onApplied();
    }, (e: Error) => onError(e.message));
  // kinds whose fixtures lack their tag but that need no new group (one fixture, or a group already there)
  const tagOnly = [...new Set(proposal.tags.map((x) => x.tag))].filter((tag) => !proposal.groups.some((g) => g.tag === tag));
  return (
    <section className="type-groups" aria-label={t.typeGroups}>
      <h3>{t.typeGroups}</h3>
      <p className="hint">{t.typeGroupsHelp}</p>
      <ul>
        {proposal.groups.map((g) => (
          <li key={g.tag} className="row">
            <span className="name">{g.name}</span>
            <span className="hint">
              {g.fixtures.length} {t.typeGroupFixtures}
            </span>
            <label title={t.typeGroupLiveHelp}>
              <input type="checkbox" checked={!fixed[g.tag]} onChange={(e) => setFixed({ ...fixed, [g.tag]: !e.target.checked })} /> {t.typeGroupLive}
            </label>
            <button onClick={() => apply({ groups: [{ tag: g.tag, live: !fixed[g.tag] }] })}>{t.typeGroupCreate}</button>
          </li>
        ))}
        {tagOnly.map((tag) => (
          <li key={tag} className="row">
            <button onClick={() => apply({ tags: [tag] })}>{t.typeTagsAdd.replace("{tag}", tag).replace("{n}", String(proposal.tags.filter((x) => x.tag === tag).length))}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

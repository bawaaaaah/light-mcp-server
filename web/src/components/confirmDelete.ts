import { cmd } from "../api";
import type { Texts } from "../i18n";
import { quoted, beforeMark } from "../typography";

/**
 * Deletes a look, a group, a channel fader or a canvas after asking. When something still uses it (a
 * fader's DCA, a mapping, a dashboard, a look on a canvas…: show.references), the question says where
 * first, and the delete is forced only on that informed yes. `shared`: a warning put first (a fixture of a
 * venue shared with other shows), which makes the delete forced on the yes too. Resolves to whether it was deleted.
 */
const DELETE_COMMAND = { look: "look.delete", group: "group.delete", fader: "fader.delete", canvas: "venue.canvas.delete", fixture: "venue.fixture.delete" } as const;

export async function confirmDelete(kind: keyof typeof DELETE_COMMAND, id: string, name: string, t: Texts, shared?: string): Promise<boolean> {
  const { uses } = await cmd<{ uses: string[] }>("show.references", { kind, id });
  const question = uses.length ? `${quoted(t, name)} ${t.usedBy}\n\n• ${uses.join("\n• ")}\n\n${t.deleteAnyway}` : `${t.delete} ${quoted(t, name)}${beforeMark(t)}?`;
  if (!confirm(shared ? `${shared}\n\n${question}` : question)) return false;
  await cmd(DELETE_COMMAND[kind], { id, force: uses.length > 0 || Boolean(shared) });
  return true;
}

import { cmd } from "../api";
import type { Texts } from "../i18n";

/**
 * Deletes a look, a group or a channel fader after asking. When something still uses it (a fader's
 * DCA, a mapping, a dashboard…: show.references), the question says where first, and the delete
 * is forced only on that informed yes. Resolves to whether it was deleted.
 */
export async function confirmDelete(kind: "look" | "group" | "fader", id: string, name: string, t: Texts): Promise<boolean> {
  const { uses } = await cmd<{ uses: string[] }>("show.references", { kind, id });
  const question = uses.length ? `« ${name} » ${t.usedBy}\n\n• ${uses.join("\n• ")}\n\n${t.deleteAnyway}` : `${t.delete} « ${name} » ?`;
  if (!confirm(question)) return false;
  await cmd(`${kind}.delete`, { id, force: uses.length > 0 });
  return true;
}

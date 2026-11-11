import { cmd } from "../api";
import type { Texts } from "../i18n";

/**
 * Deletes a look, a group, a channel fader or a canvas after asking. When something still uses it (a
 * fader's DCA, a mapping, a dashboard, a look on a canvas…: show.references), the question says where
 * first, and the delete is forced only on that informed yes. Resolves to whether it was deleted.
 */
const DELETE_COMMAND = { look: "look.delete", group: "group.delete", fader: "fader.delete", canvas: "venue.canvas.delete" } as const;

export async function confirmDelete(kind: keyof typeof DELETE_COMMAND, id: string, name: string, t: Texts): Promise<boolean> {
  const { uses } = await cmd<{ uses: string[] }>("show.references", { kind, id });
  const question = uses.length ? `« ${name} » ${t.usedBy}\n\n• ${uses.join("\n• ")}\n\n${t.deleteAnyway}` : `${t.delete} « ${name} » ?`;
  if (!confirm(question)) return false;
  await cmd(DELETE_COMMAND[kind], { id, force: uses.length > 0 });
  return true;
}

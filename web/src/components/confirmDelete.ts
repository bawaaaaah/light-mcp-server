import { ApiError, cmd } from "../api";
import type { Texts } from "../i18n";
import { quoted, beforeMark } from "../typography";

/**
 * Deletes a look, a group, a channel fader, a canvas, a fixture or an intention after asking. When
 * something still uses it (a fader's DCA, a mapping, a dashboard, a look on a canvas, a song naming an
 * intention…: show.references, read at the moment of asking), the question says where first, and the
 * delete is forced only on that informed yes. `shared`: a warning put first (a fixture of a venue
 * shared with other shows), which makes the delete forced on the yes too. When the server refuses a
 * delete it could force (`detail.force`: a fixture whose venue's other shows cannot be checked, an
 * intention of the personal library other shows still name), it asks again with what went wrong, and
 * forces on that second yes. Resolves to whether it was deleted.
 */
const DELETE_COMMAND = { look: "look.delete", group: "group.delete", fader: "fader.delete", canvas: "venue.canvas.delete", fixture: "venue.fixture.delete", intention: "intention.delete" } as const;

/** The words of the questions, when deleting is not what the command does (an intention masked, not deleted). */
export interface DeleteWording {
  /** The question when nothing uses it. */
  plain?: string;
  /** After the name, when something uses it (« est encore utilisée : »). */
  usedBy?: string;
  /** The question after the list of uses. */
  anyway?: string;
  /** The question after a refusal the server could force. */
  forced?: string;
}

export async function confirmDelete(kind: keyof typeof DELETE_COMMAND, id: string, name: string, t: Texts, shared?: string, words: DeleteWording = {}): Promise<boolean> {
  const { uses } = await cmd<{ uses: string[] }>("show.references", { kind, id });
  const question = uses.length ? `${quoted(t, name)} ${words.usedBy ?? t.usedBy}\n\n• ${uses.join("\n• ")}\n\n${words.anyway ?? t.deleteAnyway}` : (words.plain ?? `${t.delete} ${quoted(t, name)}${beforeMark(t)}?`);
  if (!confirm(shared ? `${shared}\n\n${question}` : question)) return false;
  try {
    await cmd(DELETE_COMMAND[kind], { id, force: uses.length > 0 || Boolean(shared) });
  } catch (e) {
    if (!(e instanceof ApiError && e.detail?.force)) throw e;
    const reason = typeof e.detail.reason === "string" ? e.detail.reason : e.message;
    if (!confirm(`${reason}\n\n${words.forced ?? t.deleteUnchecked}`)) return false;
    await cmd(DELETE_COMMAND[kind], { id, force: true });
  }
  return true;
}

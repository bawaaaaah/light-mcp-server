import type { ReactElement } from "react";
import { api, type KeyRow } from "../api";
import { useT } from "../i18n-context";
import { quoted } from "../typography";

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : "—");

/**
 * The security keys (YubiKey, passkeys) of the users panel and of the account page (T47): name, owner when the list
 * mixes users, where and when it was registered and last used, and « Supprimer » after asking. `onRemoved` gets the
 * delete under way (the caller says what came of it).
 */
export function PasskeyTable({ keys, ownerOf, onRemoved }: { keys: readonly KeyRow[]; ownerOf?: (userId: string) => string; onRemoved: (deleted: Promise<unknown>) => void }): ReactElement {
  const t = useT();
  return (
    <table className="keys-table">
      <tbody>
        {keys.map((k) => (
          <tr key={k.id}>
            <td>{k.name}</td>
            {ownerOf && <td className="hint">{ownerOf(k.userId)}</td>}
            <td className="hint">
              {k.rpId} · {day(k.createdAt)} · {t.lastUsed} {day(k.lastUsedAt)}
            </td>
            <td>
              <button className="ghost" onClick={() => confirm(`${t.removeKeyConfirm} ${quoted(t, k.name)}`) && onRemoved(api(`/api/auth/passkeys/${encodeURIComponent(k.id)}`, "DELETE"))}>
                {t.delete}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

import { useEffect, useState } from "react";
import { api, can, keysUsableHere, registerKey, serverInfo, shareLink, type KeyRow, type Role, type UserRow } from "../api";
import { useT } from "../App";
import { CopyButton } from "./Copy";

interface RoleRow {
  id: string;
  name: string;
  rights: string[];
}

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : "—");

/**
 * Users (administrator): each has a role (its rights), a PIN and/or hardware keys (YubiKey, passkeys).
 * Everyone signed in as a user manages their own keys here. Share links sign a user in with their PIN.
 */
export function UsersPanel({ role }: { role: Role }) {
  const t = useT();
  const admin = can(role, "auth:admin");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({ name: "", role: "benevole", pin: "" });
  const [share, setShare] = useState({ user: "", pin: "" });
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const keysHere = keysUsableHere();

  const load = () => {
    if (admin) {
      void api<UserRow[]>("/api/auth/users").then(setUsers, (e: Error) => setError(e.message));
      void api<RoleRow[]>("/api/auth/roles").then(setRoles, () => undefined);
    }
    void api<KeyRow[]>("/api/auth/passkeys").then(setKeys, () => setKeys([]));
  };
  useEffect(() => {
    load();
    void serverInfo().then((s) => setPublicUrl(s.publicUrl), () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const act = (p: Promise<unknown>, done = "") =>
    void p.then(
      () => {
        setError("");
        setMessage(done);
        load();
      },
      (e: Error) => setError(e.name === "NotAllowedError" ? t.keyCancelled : e.message),
    );
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? (id === role.user?.id ? role.name : id);
  const addKey = (user: string | undefined, name: string) => act(registerKey(user, name), t.keyAdded);
  const patch = (id: string, body: unknown) => act(api(`/api/auth/users/${id}`, "PATCH", body));

  const withPin = users.filter((u) => u.hasPin && !u.disabled);
  const shareUser = share.user || withPin[0]?.id || "";
  const base = publicUrl ?? location.origin;
  const link = shareUser && share.pin ? shareLink(base, shareUser, share.pin) : "";
  const localOnly = !publicUrl && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

  return (
    <div className="users">
      {message && <p className="hint">✔ {message}</p>}
      {error && (
        <p className="error" onClick={() => setError("")}>
          {error}
        </p>
      )}
      {admin && (
        <>
          <h2>{t.users}</h2>
          <table className="users-table">
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.disabled ? "disabled" : undefined}>
                  <td>
                    <strong>{u.name}</strong>
                    <br />
                    <small className="hint">{u.id}</small>
                  </td>
                  <td>
                    <select aria-label={`${t.role} ${u.name}`} value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <div className="row">
                      <span className="hint">{u.hasPin ? "PIN ✔" : t.noPin}</span>
                      <input type="password" inputMode="numeric" placeholder="PIN" aria-label={`PIN ${u.name}`} value={pins[u.id] ?? ""} onChange={(e) => setPins({ ...pins, [u.id]: e.target.value })} />
                      <button disabled={!pins[u.id]} onClick={() => act(api(`/api/auth/users/${u.id}/pin`, "PUT", { pin: pins[u.id] }).then(() => setPins({ ...pins, [u.id]: "" })), t.pinSaved)}>
                        ✔
                      </button>
                      {u.hasPin && (
                        <button className="ghost" title={t.removePin} onClick={() => act(api(`/api/auth/users/${u.id}/pin`, "PUT", { pin: "" }))}>
                          ✕
                        </button>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="row">
                      <span className="hint">
                        {u.keys} {t.keysCount}
                      </span>
                      {keysHere && <button onClick={() => addKey(u.id, `${t.keyOf} ${u.name}`)}>{t.addKey}</button>}
                    </div>
                  </td>
                  <td>
                    <div className="row">
                      <label className="inline">
                        <input type="checkbox" checked={!u.disabled} onChange={(e) => patch(u.id, { disabled: !e.target.checked })} /> {t.enabled}
                      </label>
                      <button className="ghost" onClick={() => confirm(`${t.deleteUserConfirm} « ${u.name} »`) && act(api(`/api/auth/users/${u.id}`, "DELETE"), t.deleted)}>
                        {t.delete}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row new-user">
            <input aria-label={t.userName} placeholder={t.userName} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <select aria-label={t.role} value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <input type="password" inputMode="numeric" aria-label={t.pinOptional} placeholder={t.pinOptional} value={draft.pin} onChange={(e) => setDraft({ ...draft, pin: e.target.value })} />
            <button
              className="primary"
              disabled={!draft.name.trim()}
              onClick={() => act(api("/api/auth/users", "POST", { ...draft, name: draft.name.trim() }).then(() => setDraft({ name: "", role: draft.role, pin: "" })), t.userAdded)}
            >
              {t.addUser}
            </button>
          </div>
          <p className="hint">{t.usersHelp}</p>
        </>
      )}

      <h2>{t.securityKeys}</h2>
      <p className="hint">{keysHere ? t.keysHelp : t.keysUnavailable}</p>
      {!admin && role.user && keysHere && <button onClick={() => addKey(undefined, `${t.keyOf} ${role.name}`)}>{t.addMyKey}</button>}
      {keys.length === 0 && <p className="hint">{t.noKeys}</p>}
      <table className="keys-table">
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td className="hint">{nameOf(k.userId)}</td>
              <td className="hint">
                {k.rpId} · {day(k.createdAt)} · {t.lastUsed} {day(k.lastUsedAt)}
              </td>
              <td>
                <button className="ghost" onClick={() => confirm(`${t.removeKeyConfirm} « ${k.name} »`) && act(api(`/api/auth/passkeys/${encodeURIComponent(k.id)}`, "DELETE"))}>
                  {t.delete}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {admin && withPin.length > 0 && (
        <div className="share-link">
          <h2>{t.shareTitle}</h2>
          <p className="hint">{t.shareHelp}</p>
          <div className="row">
            <select aria-label={t.user} value={shareUser} onChange={(e) => setShare({ ...share, user: e.target.value })}>
              {withPin.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <input type="password" inputMode="numeric" placeholder="PIN" aria-label={t.sharePin} value={share.pin} onChange={(e) => setShare({ ...share, pin: e.target.value })} />
          </div>
          {link && (
            <p className="row">
              <code className="link">{link}</code> <CopyButton text={link} />
            </p>
          )}
          {localOnly && <p className="warn">{t.shareLocal}</p>}
        </div>
      )}
    </div>
  );
}

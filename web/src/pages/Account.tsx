import { useEffect, useState } from "react";
import { api, can, keysUsableHere, registerKey, serverInfo, type KeyRow, type Role, type UserRow } from "../api";
import { useT } from "../App";

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : "—");

/**
 * Who is signed in, their security keys (YubiKey, passkeys) and their PIN. Signed in with the master
 * token there is no account to hang a key on: the page offers to create one (administrator role).
 */
export function AccountPage({ role }: { role: Role }) {
  const t = useT();
  const me = role.user;
  const admin = can(role, "auth:admin");
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [created, setCreated] = useState<UserRow | null>(null);
  const [draft, setDraft] = useState({ name: "", pin: "" });
  const [pin, setPin] = useState("");
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const keysHere = keysUsableHere();
  const owner = me?.id ?? created?.id;

  const load = () => void api<KeyRow[]>("/api/auth/passkeys").then((all) => setKeys(all.filter((k) => k.userId === owner)), () => setKeys([]));
  useEffect(load, [owner]);
  useEffect(() => {
    void serverInfo().then((s) => setPublicUrl(s.publicUrl), () => undefined);
  }, []);
  const act = (p: Promise<unknown>, done: string) =>
    void p.then(
      () => {
        setError("");
        setMessage(done);
        load();
      },
      (e: Error) => setError(e.name === "NotAllowedError" ? t.keyCancelled : e.message),
    );
  const addKey = () => act(registerKey(me ? undefined : owner, `${t.keyOf} ${me?.name ?? created?.name ?? ""}`), t.keyAdded);
  const elsewhere = publicUrl && location.origin !== publicUrl ? publicUrl : null;

  return (
    <div className="account">
      <section>
        <h2>{t.account}</h2>
        <p className="who">
          <strong>{role.name}</strong>
          {role.role && role.role !== role.name && <span className="hint"> · {role.role}</span>}
        </p>
        {!me && <p className="hint">{t.signedInWithToken}</p>}
        {message && <p className="hint">✔ {message}</p>}
        {error && (
          <p className="error" onClick={() => setError("")}>
            {error}
          </p>
        )}
      </section>

      {!me && admin && !created && (
        <section className="card">
          <h2>{t.createMyAccount}</h2>
          <p className="hint">{t.createMyAccountHelp}</p>
          <div className="row">
            <input aria-label={t.userName} placeholder={t.userName} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input type="password" inputMode="numeric" aria-label={t.pinOptional} placeholder={t.pinOptional} value={draft.pin} onChange={(e) => setDraft({ ...draft, pin: e.target.value })} />
            <button
              className="primary"
              disabled={!draft.name.trim()}
              onClick={() =>
                void api<UserRow>("/api/auth/users", "POST", { name: draft.name.trim(), role: "admin", pin: draft.pin || undefined }).then(
                  (u) => {
                    setCreated(u);
                    setMessage(t.userAdded);
                  },
                  (e: Error) => setError(e.message),
                )
              }
            >
              {t.createAccount}
            </button>
          </div>
        </section>
      )}

      {owner && (
        <section className="card">
          <h2>{t.securityKeys}</h2>
          <p className="hint">{keysHere ? t.keysHelp : t.keysUnavailable}</p>
          {!keysHere && elsewhere && (
            <p>
              <a href={elsewhere}>{elsewhere}</a>
            </p>
          )}
          {keysHere && (
            <button className="primary" onClick={addKey}>
              {t.addKey}
            </button>
          )}
          {keys.length === 0 ? (
            <p className="hint">{t.noKeys}</p>
          ) : (
            <table className="keys-table">
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="hint">
                      {k.rpId} · {day(k.createdAt)} · {t.lastUsed} {day(k.lastUsedAt)}
                    </td>
                    <td>
                      <button className="ghost" onClick={() => confirm(`${t.removeKeyConfirm} « ${k.name} »`) && act(api(`/api/auth/passkeys/${encodeURIComponent(k.id)}`, "DELETE"), t.deleted)}>
                        {t.delete}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {me && (
        <section className="card">
          <h2>{t.myPin}</h2>
          <p className="hint">{t.myPinHelp}</p>
          <div className="row">
            <input type="password" inputMode="numeric" aria-label={t.newPin} placeholder={t.newPin} value={pin} onChange={(e) => setPin(e.target.value)} />
            <button disabled={!pin} onClick={() => act(api("/api/auth/me/pin", "PUT", { pin }).then(() => setPin("")), t.pinSaved)}>
              {t.save}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

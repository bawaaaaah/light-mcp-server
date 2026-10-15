import { useEffect, useState } from "react";
import { can, cmd, downloadBackup, type Role } from "../api";
import { useT } from "../App";

interface ShowRow {
  id: string;
  name: string;
  venue: string;
  active: boolean;
  changedAt: string;
}
interface BackupRow {
  file: string;
  size: number;
  createdAt: string;
  show?: string;
}
type VenueChoice = "current" | "copy" | "new";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/**
 * Shows and backups, as the File menu of a lighting console: open, new, duplicate (« Enregistrer
 * sous »), rename, delete, reset, and .lightshow backups kept on the server. Opening a show switches
 * every screen (the app reloads when the open show changes).
 */
export function FilesPage({ role }: { role: Role }) {
  const t = useT();
  const [shows, setShows] = useState<ShowRow[]>([]);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [rename, setRename] = useState("");
  const [draft, setDraft] = useState<{ name: string; from: string; venue: VenueChoice }>({ name: "", from: "", venue: "current" });
  const [label, setLabel] = useState("");
  const [withVenue, setWithVenue] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const write = can(role, "show:write");
  const admin = can(role, "show:admin");

  const load = () => {
    void cmd<ShowRow[]>("show.list").then(setShows).catch((e: Error) => setError(e.message));
    void cmd<BackupRow[]>("backup.list").then(setBackups).catch(() => undefined);
  };
  useEffect(load, []);
  const act = (p: Promise<unknown>, done?: string) =>
    void p.then(
      () => {
        setError("");
        setMessage(done ?? "");
        load();
      },
      (e: Error) => setError(e.message),
    );
  const current = shows.find((s) => s.active);

  return (
    <div className="files">
      {message && <p className="hint">✔ {message}</p>}
      {error && (
        <p className="error" onClick={() => setError("")}>
          {error}
        </p>
      )}
      <section>
        <h2>{t.openShow}</h2>
        <p className="current-show">
          <strong>{current?.name ?? "…"}</strong> <small className="hint">({t.venue} {current?.venue})</small>
        </p>
        {write && (
          <div className="row">
            <input aria-label={t.renameShow} placeholder={t.renameShow} value={rename} onChange={(e) => setRename(e.target.value)} />
            <button disabled={!rename.trim()} onClick={() => act(cmd("show.rename", { name: rename.trim() }).then(() => setRename("")), t.renamed)}>
              {t.rename}
            </button>
          </div>
        )}
      </section>

      <section>
        <h2>{t.shows}</h2>
        <table className="shows">
          <tbody>
            {shows.map((s) => (
              <tr key={s.id} className={s.active ? "active" : undefined}>
                <td>
                  {s.active ? "▶ " : ""}
                  {s.name}
                </td>
                <td className="hint">
                  {t.venue} {s.venue}
                </td>
                <td className="hint">{when(s.changedAt)}</td>
                <td className="row">
                  {write && !s.active && <button onClick={() => act(cmd("show.open", { id: s.id }))}>{t.open}</button>}
                  {write && (
                    <button onClick={() => setDraft({ name: `${s.name} (${t.copySuffix})`, from: s.id, venue: "current" })}>{t.duplicate}</button>
                  )}
                  {admin && !s.active && (
                    <button className="ghost" onClick={() => confirm(`${t.deleteShowConfirm} « ${s.name} »`) && act(cmd("show.delete", { id: s.id }), t.deleted)}>
                      {t.delete}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {write && (
        <section className="new-show">
          <h2>{draft.from ? t.duplicateShow : t.newShow}</h2>
          <div className="row">
            <input aria-label={t.showName} placeholder={t.showName} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <label className="inline">
              {t.startFrom}{" "}
              <select value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })}>
                <option value="">{t.emptyShow}</option>
                {shows.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              {t.venue}{" "}
              <select value={draft.venue} onChange={(e) => setDraft({ ...draft, venue: e.target.value as VenueChoice })}>
                <option value="current">{t.venueSame}</option>
                <option value="copy">{t.venueCopy}</option>
                <option value="new">{t.venueNew}</option>
              </select>
            </label>
            <button
              className="primary"
              disabled={!draft.name.trim()}
              onClick={() => act(cmd("show.create", { name: draft.name.trim(), from: draft.from || undefined, venue: draft.venue }).then(() => setDraft({ name: "", from: "", venue: "current" })))}
            >
              {t.createAndOpen}
            </button>
          </div>
          <p className="hint">{t.newShowHelp}</p>
        </section>
      )}

      <section>
        <h2>{t.backups}</h2>
        {write && (
          <div className="row">
            <input aria-label={t.backupLabel} placeholder={t.backupLabel} value={label} onChange={(e) => setLabel(e.target.value)} />
            <button onClick={() => act(cmd("backup.create", label.trim() ? { label: label.trim() } : {}).then(() => setLabel("")), t.backupSaved)}>{t.saveBackup}</button>
          </div>
        )}
        {backups.length === 0 && <p className="hint">{t.noBackups}</p>}
        <table className="backups">
          <tbody>
            {backups.map((b) => (
              <tr key={b.file}>
                <td>{when(b.createdAt)}</td>
                <td className="hint">{b.file}</td>
                <td className="hint">{Math.max(1, Math.round(b.size / 1024))} Kio</td>
                <td className="row">
                  {write && (
                    <button onClick={() => confirm(`${t.restoreBackupConfirm}\n\n${b.file}`) && act(cmd("backup.restore", { file: b.file }), t.restored)}>{t.restore}</button>
                  )}
                  <button className="ghost" onClick={() => void downloadBackup(b.file).catch((e: Error) => setError(e.message))}>
                    ⤓
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {admin && (
        <section className="danger-zone">
          <h2>{t.resetShow}</h2>
          <p className="hint">{t.resetHelp}</p>
          <div className="row">
            <label className="inline">
              <input type="checkbox" checked={withVenue} onChange={(e) => setWithVenue(e.target.checked)} /> {t.resetVenueToo}
            </label>
            <button className="danger" onClick={() => confirm(withVenue ? t.resetConfirmVenue : t.resetConfirm) && act(cmd("show.reset", { venue: withVenue }), t.resetDone)}>
              {t.resetShow}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

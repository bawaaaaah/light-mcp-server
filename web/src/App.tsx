import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ApiError, can, keysUsableHere, lightState, login, loginUsers, loginWithKey, loginWithToken, logout, restoreSession, type Role } from "./api";
import { initialLang, TEXTS, type Lang, type Texts } from "./i18n";
import { control, stream } from "./ws";
import { useTopic } from "./hooks/useTopic";
import { DashboardsPage } from "./pages/Dashboards";
import { ConsolePage } from "./pages/Console";
import { MidiPage } from "./pages/Midi";
import { ImportPage } from "./pages/Import";
import { SongsPage } from "./pages/Songs";
import { ShowPage } from "./pages/Show";
import { OscPage } from "./pages/Osc";
import { VenuePage } from "./pages/Venue";
import { NotesPage } from "./pages/Notes";
import { SettingsPage } from "./pages/Settings";
import { ConnectPage } from "./pages/Connect";
import { FilesPage } from "./pages/Files";

export const I18n = createContext<Texts>(TEXTS.fr);
export const useT = () => useContext(I18n);

type Page = "live" | "songs" | "show" | "venue" | "console" | "midi" | "osc" | "import" | "notes" | "files" | "connect" | "settings";
const PAGES: Page[] = ["live", "songs", "show", "venue", "console", "midi", "osc", "import", "notes", "files", "connect", "settings"];
/** Pages a role sees only with a right; the others are for every role. */
const PAGE_RIGHTS: Partial<Record<Page, string>> = { connect: "mcp:use" };

type LightState = Awaited<ReturnType<typeof lightState>>;

/** A refused PIN reads as such; anything else (too many tries) keeps the server's words. */
const pinError = (e: unknown, t: Texts) => (e instanceof ApiError && e.status !== 401 ? e.message : t.badPin);

/** The master token first (default), a hardware key where it works, then a PIN for a user picked below. */
function Login({ onLogin, t, initialError = "" }: { onLogin: (r: Role) => void; t: Texts; initialError?: string }) {
  const [token, setToken] = useState("");
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [keys, setKeys] = useState(false);
  const [user, setUser] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState(initialError);
  useEffect(() => {
    void loginUsers()
      .then((r) => {
        setUsers(r.users);
        setKeys(r.keys && keysUsableHere());
        setUser(r.users[0]?.id ?? "");
      })
      .catch(() => setUsers([]));
  }, []);
  const signInWithKey = () =>
    void loginWithKey().then(onLogin, (err: Error) => setError(err.name === "NotAllowedError" ? t.keyCancelled : err.message));
  const submitToken = async (e: React.FormEvent) => {
    e.preventDefault();
    const role = await loginWithToken(token.trim());
    if (role) onLogin(role);
    else {
      setError(t.badToken);
      setToken("");
    }
  };
  const submitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      onLogin(await login(pin, user || undefined));
    } catch (err) {
      setError(pinError(err, t));
      setPin("");
    }
  };
  return (
    <div className="login">
      <h1>{t.appName}</h1>
      <form className="token-login" onSubmit={submitToken}>
        <input autoFocus type="password" autoComplete="off" placeholder={t.token} value={token} onChange={(e) => setToken(e.target.value)} />
        <button type="submit" disabled={!token.trim()}>
          {t.login}
        </button>
      </form>
      {keys && (
        <button type="button" className="key-login" onClick={signInWithKey}>
          {t.loginWithKey}
        </button>
      )}
      <h2>{t.orPin}</h2>
      {users.length === 0 ? (
        <p className="hint">{t.noPins}</p>
      ) : (
        <form className="pin-login" onSubmit={submitPin}>
          <select aria-label={t.user} value={user} onChange={(e) => setUser(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <input inputMode="numeric" type="password" placeholder={t.pin} value={pin} onChange={(e) => setPin(e.target.value)} />
          <button type="submit" disabled={!pin}>
            {t.login}
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang());
  const [role, setRole] = useState<Role | null>(null);
  const [checked, setChecked] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [up, setUp] = useState(false);
  const live = useTopic<LightState | null>("light:state", null);
  // The topic only speaks on a change: read the current state once signed in.
  const [seed, setSeed] = useState<LightState | null>(null);
  const output = live ?? seed;
  const openShow = useRef<string | undefined>(undefined);
  const [page, setPage] = useState<Page>(() => (PAGES.includes(location.hash.slice(1) as Page) ? (location.hash.slice(1) as Page) : "live"));
  const t = TEXTS[lang];

  useEffect(() => {
    void restoreSession()
      .then(setRole, (err: unknown) => setLinkError(pinError(err, TEXTS[lang])))
      .finally(() => setChecked(true));
  }, []);
  useEffect(() => {
    if (role) void lightState().then(setSeed, () => undefined);
  }, [role]);
  useEffect(() => {
    if (!role) return;
    const off = control.onStatus(setUp);
    void control.connect();
    void stream.connect();
    return () => {
      off();
      control.close();
      stream.close();
    };
  }, [role]);
  useEffect(() => {
    location.hash = page;
  }, [page]);
  // Another show opened (here or on another screen): every page reloads its data.
  useEffect(() => {
    const id = output?.show?.id;
    if (!id) return;
    if (openShow.current && openShow.current !== id) location.reload();
    openShow.current = id;
  }, [output?.show?.id]);

  const switchLang = (l: Lang) => {
    setLang(l);
    try {
      localStorage.setItem("lang", l);
    } catch {
      /* ignore */
    }
  };

  if (!checked) return null;
  if (!role) return <Login t={t} onLogin={setRole} initialError={linkError} />;
  const pages = PAGES.filter((p) => !PAGE_RIGHTS[p] || can(role, PAGE_RIGHTS[p]));
  return (
    <I18n.Provider value={t}>
      <header className="top">
        <nav>
          {pages.map((p) => (
            <button key={p} className={p === page ? "tab active" : "tab"} onClick={() => setPage(p)}>
              {t[p]}
            </button>
          ))}
        </nav>
        <div className="right">
          {output?.show && (
            <button className="badge show-name" title={t.openShow} onClick={() => setPage("files")}>
              {output.show.name}
            </button>
          )}
          {output?.standby && (
            <span className="badge standby" title={`${t.standby}${output.foreignSources?.length ? ` · ${t.otherHolds} ${output.foreignSources.join(", ")}` : ""}. ${t.standbyHelp}`}>
              ⏸ {t.standbyShort}
            </span>
          )}
          {!output?.standby && output?.foreignSources?.length ? (
            <span className="badge conflict" title={t.otherSourceHelp}>
              ⚠ {t.otherSource} : {output.foreignSources.join(", ")}
            </span>
          ) : null}
          {output?.program && (
            <span className="badge standby" title={t.programActiveHelp}>
              {t.programLabel} : {output.program}
            </span>
          )}
          <span className={up ? "dot ok" : "dot ko"} title={up ? t.connected : t.disconnected} />
          <span className="role">{role.name}</span>
          <select aria-label={t.language} value={lang} onChange={(e) => switchLang(e.target.value as Lang)}>
            <option value="fr">FR</option>
            <option value="en">EN</option>
          </select>
          <button
            className="ghost"
            onClick={() => {
              void logout().then(() => setRole(null));
            }}
          >
            {t.logout}
          </button>
        </div>
      </header>
      <main>
        {page === "live" && <DashboardsPage />}
        {page === "songs" && <SongsPage />}
        {page === "show" && <ShowPage />}
        {page === "venue" && <VenuePage />}
        {page === "console" && <ConsolePage />}
        {page === "midi" && <MidiPage />}
        {page === "osc" && <OscPage />}
        {page === "import" && <ImportPage />}
        {page === "notes" && <NotesPage />}
        {page === "files" && <FilesPage role={role} />}
        {page === "connect" && pages.includes("connect") && <ConnectPage role={role} />}
        {page === "settings" && <SettingsPage role={role} />}
      </main>
    </I18n.Provider>
  );
}

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ApiError, can, keysUsableHere, lightState, login, loginUsers, loginWithKey, loginWithToken, logout, onSignedOut, rememberOnDevice, remembered, restoreSession, unreachable, type Role } from "./api";
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
import { AccountPage } from "./pages/Account";

export const I18n = createContext<Texts>(TEXTS.fr);
export const useT = () => useContext(I18n);
/** Opens another page from inside one (the getting-started guide, links between pages). */
export const Nav = createContext<(page: Page) => void>(() => undefined);
export const useNav = () => useContext(Nav);

export type Page = "live" | "songs" | "show" | "venue" | "console" | "midi" | "osc" | "import" | "notes" | "files" | "connect" | "settings" | "account";
/** The pages by what one does there; the side bar (or the tab strip on a tablet) shows these groups. */
const GROUPS: [keyof Texts, Page[]][] = [
  ["navPlay", ["live", "songs"]],
  ["navDesign", ["show", "venue", "console"]],
  ["navConnect", ["midi", "osc", "connect"]],
  ["navData", ["import", "files", "notes"]],
  ["navSystem", ["settings", "account"]],
];
const PAGES: Page[] = GROUPS.flatMap(([, pages]) => pages);
/**
 * The right a page needs: the one its commands ask for, so a role only sees what it can use
 * (a volunteer gets Live and their account; the server refuses the rest anyway).
 */
const PAGE_RIGHTS: Partial<Record<Page, string>> = {
  live: "dashboards:view",
  songs: "show:write",
  show: "show:write",
  venue: "show:write",
  console: "commands:dmx",
  midi: "midi:configure",
  osc: "show:write",
  import: "show:write",
  files: "show:write",
  notes: "show:write",
  connect: "mcp:use",
  settings: "show:write",
};

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
  const [stay, setStay] = useState(remembered());
  useEffect(() => rememberOnDevice(stay), [stay]);
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
      <label className="inline stay" title={t.staySignedInHelp}>
        <input type="checkbox" checked={stay} onChange={(e) => setStay(e.target.checked)} /> {t.staySignedIn}
      </label>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang());
  const [role, setRole] = useState<Role | null>(null);
  const [checked, setChecked] = useState(false);
  const [unreachableServer, setUnreachableServer] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [up, setUp] = useState(false);
  // The link down for more than a moment (server restarting, network): said plainly, buttons are dead.
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (up || !role) return setLost(false);
    const timer = window.setTimeout(() => setLost(true), 3000);
    return () => window.clearTimeout(timer);
  }, [up, role]);
  useEffect(
    () =>
      onSignedOut(() => {
        setRole(null);
        setLinkError(TEXTS[lang].sessionEnded);
      }),
    [lang],
  );
  const live = useTopic<LightState | null>("light:state", null);
  const sourceName = (ip: string) => (output?.foreignLocal?.includes(ip) ? `${ip} (${t.thisMachine})` : ip);
  // The topic only speaks on a change: read the current state once signed in.
  const [seed, setSeed] = useState<LightState | null>(null);
  const output = live ?? seed;
  const openShow = useRef<string | undefined>(undefined);
  const [page, setPage] = useState<Page>(() => (PAGES.includes(location.hash.slice(1) as Page) ? (location.hash.slice(1) as Page) : "live"));
  const t = TEXTS[lang];

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    // the server restarting (or the network) is no reason to sign out: say so and try again
    const attempt = () =>
      void restoreSession().then(
        (r) => {
          if (stop) return;
          setUnreachableServer(false);
          setRole(r);
          setChecked(true);
        },
        (err: unknown) => {
          if (stop) return;
          if (unreachable(err)) {
            setUnreachableServer(true);
            timer = window.setTimeout(attempt, 2000);
            return;
          }
          setLinkError(pinError(err, TEXTS[lang]));
          setChecked(true);
        },
      );
    attempt();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
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
    // on a phone the page strip scrolls: keep the open page in sight
    document.querySelector("nav.pages .tab.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
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

  if (!checked) return unreachableServer ? <p className="unreachable" role="alert">{t.serverUnreachable}</p> : null;
  if (!role) return <Login t={t} onLogin={setRole} initialError={linkError} />;
  const allowed = (p: Page) => !PAGE_RIGHTS[p] || can(role, PAGE_RIGHTS[p]);
  const pages = PAGES.filter(allowed);
  const shown: Page = allowed(page) ? page : (pages[0] ?? "account");
  return (
    <I18n.Provider value={t}>
      <Nav.Provider value={(p) => allowed(p) && setPage(p)}>
      <div className="app">
      <aside className="sidebar">
        <div className="brand">{t.appName}</div>
        <nav className="pages" aria-label={t.navigation}>
          {GROUPS.map(([group, ps]) => {
            const visible = ps.filter(allowed);
            if (!visible.length) return null;
            return (
              <div className="nav-group" key={group}>
                <span className="nav-title">{t[group] as string}</span>
                {visible.map((p) => (
                  <button key={p} className={p === shown ? "tab active" : "tab"} aria-current={p === shown ? "page" : undefined} onClick={() => setPage(p)}>
                    {t[p] as string}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="main-col">
      {lost && (
        <div className="link-lost" role="alert">
          ⚠ {t.linkLost}
        </div>
      )}
      <header className="top">
        <div className="status">
          {output?.show && (
            <button className="badge show-name" title={t.openShow} onClick={() => allowed("files") && setPage("files")}>
              {output.show.name}
            </button>
          )}
          {output?.standby && (
            <span className="badge standby" title={`${t.standby}${output.foreignSources?.length ? ` · ${t.otherHolds} ${output.foreignSources.map(sourceName).join(", ")}` : ""}. ${t.standbyHelp}`}>
              ⏸ {t.standbyShort}
            </span>
          )}
          {!output?.standby && output?.foreignSources?.length ? (
            <span className="badge conflict" title={t.otherSourceHelp}>
              ⚠ {t.otherSource} : {output.foreignSources.map(sourceName).join(", ")}
            </span>
          ) : null}
          {output?.parked ? (
            <button className="badge conflict" title={t.parkedHelp} onClick={() => allowed("console") && setPage("console")}>
              🔧 {output.parked} {t.parkedChannels}
            </button>
          ) : null}
          {output?.program && (
            <span className="badge standby" title={t.programActiveHelp}>
              {t.programLabel} : {output.program}
            </span>
          )}
        </div>
        <div className="right">
          <span className={up ? "dot ok" : "dot ko"} title={up ? t.connected : t.disconnected} />
          <button className="role ghost" title={`${role.role ?? role.name} · ${t.account}`} onClick={() => setPage("account")}>
            {role.name}
          </button>
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
        {shown === "live" && <DashboardsPage role={role} />}
        {shown === "songs" && <SongsPage />}
        {shown === "show" && <ShowPage />}
        {shown === "venue" && <VenuePage />}
        {shown === "console" && <ConsolePage />}
        {shown === "midi" && <MidiPage />}
        {shown === "osc" && <OscPage />}
        {shown === "import" && <ImportPage />}
        {shown === "notes" && <NotesPage />}
        {shown === "files" && <FilesPage role={role} />}
        {shown === "connect" && <ConnectPage role={role} />}
        {shown === "settings" && <SettingsPage role={role} />}
        {shown === "account" && <AccountPage role={role} />}
      </main>
      </div>
      </div>
      </Nav.Provider>
    </I18n.Provider>
  );
}

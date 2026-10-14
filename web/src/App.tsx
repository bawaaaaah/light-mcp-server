import { createContext, useContext, useEffect, useState } from "react";
import { login, logout, me, type Role } from "./api";
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

export const I18n = createContext<Texts>(TEXTS.fr);
export const useT = () => useContext(I18n);

type Page = "live" | "songs" | "show" | "venue" | "console" | "midi" | "osc" | "import" | "notes" | "settings";
const PAGES: Page[] = ["live", "songs", "show", "venue", "console", "midi", "osc", "import", "notes", "settings"];

function Login({ onLogin, t }: { onLogin: (r: Role) => void; t: Texts }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      onLogin(await login(pin));
    } catch {
      setError(t.badPin);
      setPin("");
    }
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1>{t.appName}</h1>
      <input autoFocus inputMode="numeric" type="password" placeholder={t.pin} value={pin} onChange={(e) => setPin(e.target.value)} />
      <button type="submit">{t.login}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang());
  const [role, setRole] = useState<Role | null>(null);
  const [checked, setChecked] = useState(false);
  const [up, setUp] = useState(false);
  const output = useTopic<{ standby?: boolean; foreignSources?: string[] } | null>("light:state", null);
  const [page, setPage] = useState<Page>(() => (PAGES.includes(location.hash.slice(1) as Page) ? (location.hash.slice(1) as Page) : "live"));
  const t = TEXTS[lang];

  useEffect(() => {
    void me().then((r) => {
      setRole(r);
      setChecked(true);
    });
  }, []);
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

  const switchLang = (l: Lang) => {
    setLang(l);
    try {
      localStorage.setItem("lang", l);
    } catch {
      /* ignore */
    }
  };

  if (!checked) return null;
  if (!role) return <Login t={t} onLogin={setRole} />;
  return (
    <I18n.Provider value={t}>
      <header className="top">
        <nav>
          {PAGES.map((p) => (
            <button key={p} className={p === page ? "tab active" : "tab"} onClick={() => setPage(p)}>
              {t[p]}
            </button>
          ))}
        </nav>
        <div className="right">
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
        {page === "settings" && <SettingsPage />}
      </main>
    </I18n.Provider>
  );
}

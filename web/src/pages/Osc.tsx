import { useEffect, useMemo, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";

interface Route {
  address: string;
  command: string;
  params: string[];
  description: string;
}

/** OSC explorer (docs/specs/midi.md): every address with its parameters, searchable, one-click copy. */
export function OscPage() {
  const t = useT();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    void cmd<Route[]>("osc.table").then(setRoutes).catch(() => undefined);
  }, []);
  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return routes.filter((r) => !q || r.address.includes(q) || r.description.toLowerCase().includes(q));
  }, [routes, query]);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      setTimeout(() => setCopied(""), 1200);
    });
  };
  const exportTable = () => {
    const md = ["| Adresse | Paramètres | Action |", "|---|---|---|", ...routes.map((r) => `| \`${r.address}\` | ${r.params.join(" ")} | ${r.description} |`)].join("\n");
    copy(md);
  };
  return (
    <div className="osc">
      <section className="bar">
        <input className="search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={exportTable}>{t.copyTable}</button>
        <span className="hint">{t.oscHelp}</span>
      </section>
      <table>
        <tbody>
          {shown.map((r) => (
            <tr key={r.address}>
              <td>
                <code>{r.address}</code>
              </td>
              <td>
                <small>{r.params.join(" ")}</small>
              </td>
              <td>{r.description}</td>
              <td>
                <button className="ghost" onClick={() => copy(r.address)}>
                  {copied === r.address ? "✔" : "⧉"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

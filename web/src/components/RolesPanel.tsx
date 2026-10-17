import { useEffect, useState } from "react";
import { api, cmd, grants } from "../api";
import { useT } from "../App";

interface RoleRow {
  id: string;
  name: string;
  rights: string[];
  dashboards?: string[];
}

/** The rights a role can be given, by area, as the commands ask for them (see `right` in the command layer). */
const AREAS: [area: string, rights: string[]][] = [
  ["live", ["commands:trigger", "commands:level", "commands:panic", "commands:blackout", "commands:tempo", "commands:position", "commands:snapshot"]],
  ["technique", ["commands:dmx", "commands:output", "commands:selftest", "midi:configure", "midi:input"]],
  ["design", ["show:propose", "show:write", "show:admin"]],
  ["access", ["dashboards:view", "mcp:use", "auth:admin"]],
];
const BUILT_IN = ["admin", "regisseur", "benevole", "lecture"];


/** Toggling one right expands a wildcard of its area (« commands:* ») into the rights it stood for. */
function toggle(rights: string[], right: string): string[] {
  const area = right.split(":")[0]!;
  const all = AREAS.flatMap(([, r]) => r).filter((r) => r.startsWith(`${area}:`));
  let out = rights.includes(`${area}:*`) ? [...rights.filter((r) => r !== `${area}:*`), ...all] : [...rights];
  out = grants(out, right) ? out.filter((r) => r !== right) : [...out, right];
  return [...new Set(out)];
}

/**
 * Roles (administrator): the rights of each, by what they let one do, and the dashboards it sees.
 * The administrator keeps every right; built-in roles stay; a role given to nobody can go.
 */
export function RolesPanel() {
  const t = useT();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [dashboards, setDashboards] = useState<{ id: string; name: string }[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const load = () => void api<RoleRow[]>("/api/auth/roles").then(setRoles, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
    void cmd<{ id: string; name: string }[]>("dashboard.list").then(setDashboards, () => undefined);
  }, []);
  /** Shown at once, then saved; a refusal reloads what the server keeps. */
  const patch = (id: string, body: { rights?: string[]; dashboards?: string[] | null }) => {
    setRoles((rs) => rs.map((r) => (r.id === id ? { ...r, ...(body.rights ? { rights: body.rights } : {}), ...("dashboards" in body ? { dashboards: body.dashboards ?? undefined } : {}) } : r)));
    void api(`/api/auth/roles/${id}`, "PATCH", body).then(undefined, (e: Error) => {
      setError(e.message);
      load();
    });
  };

  return (
    <div className="roles">
      <h2>{t.roles}</h2>
      <p className="hint">{t.rolesHelp}</p>
      {error && (
        <p className="error" onClick={() => setError("")}>
          {error}
        </p>
      )}
      <table className="roles-table">
        <thead>
          <tr>
            <th />
            {roles.map((r) => (
              <th key={r.id}>
                {r.name}
                {!BUILT_IN.includes(r.id) && (
                  <button className="ghost" title={t.delete} onClick={() => confirm(`${t.delete} « ${r.name} » ?`) && void api(`/api/auth/roles/${r.id}`, "DELETE").then(load, (e: Error) => setError(e.message))}>
                    ✕
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {AREAS.map(([area, rights]) => [
            <tr key={area} className="area">
              <td colSpan={roles.length + 1}>{t.rightAreas[area as keyof typeof t.rightAreas]}</td>
            </tr>,
            ...rights.map((right) => (
              <tr key={right}>
                <td>{t.rightNames[right as keyof typeof t.rightNames] ?? right}</td>
                {roles.map((r) => (
                  <td key={r.id} className="check">
                    <input
                      type="checkbox"
                      aria-label={`${r.name} · ${t.rightNames[right as keyof typeof t.rightNames] ?? right}`}
                      checked={grants(r.rights, right)}
                      disabled={r.id === "admin"}
                      onChange={() => patch(r.id, { rights: toggle(r.rights, right) })}
                    />
                  </td>
                ))}
              </tr>
            )),
          ])}
          <tr className="area">
            <td colSpan={roles.length + 1}>{t.visibleDashboards}</td>
          </tr>
          {dashboards.map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              {roles.map((r) => (
                <td key={r.id} className="check">
                  <input
                    type="checkbox"
                    aria-label={`${r.name} · ${d.name}`}
                    checked={!r.dashboards?.length || r.dashboards.includes(d.id)}
                    disabled={r.id === "admin"}
                    onChange={(e) => {
                      const current = r.dashboards?.length ? r.dashboards : dashboards.map((x) => x.id);
                      const next = e.target.checked ? [...current, d.id] : current.filter((x) => x !== d.id);
                      patch(r.id, { dashboards: next.length === dashboards.length ? null : next });
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <input aria-label={t.roleName} placeholder={t.roleName} value={name} onChange={(e) => setName(e.target.value)} />
        <button
          disabled={!name.trim()}
          onClick={() =>
            void api("/api/auth/roles", "POST", { name: name.trim(), rights: ["dashboards:view"] }).then(() => {
              setName("");
              load();
            }, (e: Error) => setError(e.message))
          }
        >
          {t.addRole}
        </button>
      </div>
    </div>
  );
}

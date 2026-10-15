import { useEffect, useState } from "react";
import { getToken, serverInfo, type Role } from "../api";
import { useT } from "../App";
import { CodeBlock, CopyButton } from "../components/Copy";

type Client = "claude-code" | "claude-desktop" | "claude-ai" | "stdio" | "inspector" | "curl";
const CLIENTS: [Client, string][] = [
  ["claude-code", "Claude Code"],
  ["claude-desktop", "Claude Desktop"],
  ["claude-ai", "claude.ai"],
  ["stdio", "Local (stdio)"],
  ["inspector", "MCP Inspector"],
  ["curl", "curl"],
];

/** How to plug an MCP client into this server, and how to publish it behind a reverse proxy. */
export function ConnectPage({ role }: { role: Role }) {
  const t = useT();
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [client, setClient] = useState<Client>("claude-code");
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    void serverInfo()
      .then((s) => setPublicUrl(s.publicUrl))
      .catch(() => undefined);
  }, []);

  const origin = publicUrl ?? location.origin;
  const mcpUrl = `${origin}/mcp`;
  // Only a browser signed in with the token knows it; a PIN session gets a placeholder.
  const token = (role.kind === "static" && getToken()) || t.tokenPlaceholder;
  const hasToken = token !== t.tokenPlaceholder;
  const shown = hasToken && !revealed ? "•".repeat(24) : token;
  /** Each snippet twice: with the real token (copied) and with the masked one (shown). */
  const snippet = (make: (tok: string) => string) => ({ code: make(token), display: make(shown) });

  const claudeCode = snippet((tok) => `claude mcp add --transport http light ${mcpUrl} \\\n  --header "Authorization: Bearer ${tok}"`);
  const mcpRemote = snippet((tok) =>
    JSON.stringify({ mcpServers: { light: { command: "npx", args: ["-y", "mcp-remote", mcpUrl, "--header", `Authorization: Bearer ${tok}`] } } }, null, 2),
  );
  const curl = snippet(
    (tok) => `curl -X POST "${mcpUrl}" \\\n  -H "Authorization: Bearer ${tok}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'`,
  );
  const stdio = "claude mcp add light -- node /chemin/vers/light-mcp-server/dist/cli/main.js serve --stdio --no-http";
  const config = JSON.stringify({ server: { publicUrl: "https://lumiere.example.com", host: "127.0.0.1", port: 8790 } }, null, 2);
  const caddy = "lumiere.example.com {\n  reverse_proxy 127.0.0.1:8790\n}";
  const nginx = [
    "server {",
    "  listen 443 ssl;",
    "  server_name lumiere.example.com;",
    "  # ssl_certificate … ; ssl_certificate_key … ;",
    "  location / {",
    "    proxy_pass http://127.0.0.1:8790;",
    "    proxy_http_version 1.1;",
    "    proxy_set_header Host $host;",
    "    proxy_set_header Upgrade $http_upgrade;",
    '    proxy_set_header Connection "upgrade";',
    "    proxy_buffering off;",
    "    proxy_read_timeout 1h;",
    "  }",
    "}",
  ].join("\n");

  return (
    <div className="connect">
      <section>
        <h2>{t.connectTitle}</h2>
        <p>{t.connectIntro}</p>
        <dl className="connect-fields">
          <dt>{t.endpoint}</dt>
          <dd>
            <code>{mcpUrl}</code> <CopyButton text={mcpUrl} />
          </dd>
          <dt>{t.accessToken}</dt>
          <dd>
            {hasToken ? (
              <>
                <code>{shown}</code>{" "}
                <button type="button" onClick={() => setRevealed(!revealed)}>
                  {revealed ? t.hide : t.reveal}
                </button>{" "}
                <CopyButton text={token} />
              </>
            ) : (
              <span className="hint">
                {t.tokenHidden} <code>npm run light -- token</code>
              </span>
            )}
          </dd>
        </dl>
        <p className="hint">{t.tokenHelp}</p>
      </section>

      <section>
        <h2>{t.pickClient}</h2>
        <nav className="row">
          {CLIENTS.map(([id, label]) => (
            <button key={id} className={id === client ? "tab active" : "tab"} onClick={() => setClient(id)}>
              {label}
            </button>
          ))}
        </nav>
        {client === "claude-code" && (
          <>
            <p>{t.runOnce}</p>
            <CodeBlock {...claudeCode} />
            <p className="hint">{t.claudeCodeHelp}</p>
          </>
        )}
        {client === "claude-desktop" && (
          <>
            <ol>
              {t.claudeDesktopSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="hint">{t.claudeDesktopAlt}</p>
            <CodeBlock {...mcpRemote} />
          </>
        )}
        {client === "claude-ai" && <p>{t.claudeAiHelp}</p>}
        {client === "stdio" && (
          <>
            <p>{t.stdioHelp}</p>
            <CodeBlock code={stdio} />
          </>
        )}
        {client === "inspector" && (
          <>
            <CodeBlock code="npx @modelcontextprotocol/inspector" />
            <p className="hint">{t.inspectorHelp}</p>
          </>
        )}
        {client === "curl" && (
          <>
            <p>{t.curlHelp}</p>
            <CodeBlock {...curl} />
          </>
        )}
      </section>

      <section>
        <h2>{t.remoteTitle}</h2>
        <p>
          {t.publicUrlNow} <code>{publicUrl ?? t.publicUrlNone}</code>
        </p>
        <p>{t.remoteIntro}</p>
        <CodeBlock code={config} />
        <p className="hint">{t.remoteConfigHelp}</p>
        <p>{t.caddyHelp}</p>
        <CodeBlock code={caddy} />
        <p>{t.nginxHelp}</p>
        <CodeBlock code={nginx} />
        <p className="warn">{t.remoteWarn}</p>
      </section>
    </div>
  );
}

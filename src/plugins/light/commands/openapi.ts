/**
 * OpenAPI 3.0 description of the HTTP API (docs/specs/data-cli-sdk.md, « SDK »), generated from the
 * command registry: one POST route per command, its arguments' JSON schema, its right and whether
 * it writes. Scripts in any language (Python included) can be written against it.
 */
import { z } from "zod";
import type { CommandDef } from "./registry.js";

const ERROR = { type: "object", properties: { ok: { type: "boolean", enum: [false] }, error: { type: "string" }, detail: {} }, required: ["error"] };

export function openApiDocument(commands: CommandDef[], version: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {
    "/api/auth/login": {
      post: {
        operationId: "login",
        summary: "Connexion par PIN : renvoie un jeton (Bearer) et le rôle",
        security: [],
        tags: ["auth"],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { pin: { type: "string" } }, required: ["pin"] } } } },
        responses: { "200": { description: "jeton et rôle", content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" }, role: { type: "object" } } } } } }, "401": { description: "PIN incorrect" } },
      },
    },
    "/api/plugins/light/state": { get: { operationId: "state", summary: "État : blackout, veille, univers, autres consoles", tags: ["light"], responses: { "200": { description: "état" }, "401": { description: "jeton manquant ou invalide" } } } },
    "/api/plugins/light/archive": {
      get: { operationId: "archiveDownload", summary: "Sauvegarde .lightshow du show (et du lieu, sauf venue=0)", tags: ["light"], parameters: [{ name: "venue", in: "query", schema: { type: "string", enum: ["0", "1"] } }], responses: { "200": { description: "archive", content: { "application/zip": {} } }, "403": { description: "droit requis : show:write" } } },
      post: { operationId: "archiveRestore", summary: "Restaure une sauvegarde .lightshow (copie de l'existant d'abord)", tags: ["light"], requestBody: { required: true, content: { "application/zip": { schema: { type: "string", format: "binary" } } } }, responses: { "200": { description: "restauré" }, "400": { description: "archive illisible" } } },
    },
  };
  for (const c of commands) {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(c.schema, { target: "openapi-3.0", io: "input", reused: "inline", unrepresentable: "any" }) as Record<string, unknown>;
    paths[`/api/plugins/light/commands/${c.name}`] = {
      post: {
        operationId: c.name.replace(/[._](\w)/g, (_m, ch: string) => ch.toUpperCase()),
        summary: c.title,
        description: `${c.description}\n\nDroit : \`${c.right}\`${c.readOnly ? " · lecture seule" : ""}. MCP : \`light_${c.name.replace(/\./g, "_")}\`, OSC : \`/light/${c.name.replace(/\./g, "/")}\`.`,
        tags: [c.name.split(".")[0]],
        "x-right": c.right,
        "x-read-only": Boolean(c.readOnly),
        requestBody: { required: true, content: { "application/json": { schema } } },
        responses: {
          "200": { description: "résultat", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, result: {} } } } } },
          "400": { description: "arguments invalides", content: { "application/json": { schema: ERROR } } },
          "403": { description: "droit manquant", content: { "application/json": { schema: ERROR } } },
          "404": { description: "commande inconnue", content: { "application/json": { schema: ERROR } } },
          "422": { description: "la commande a échoué (look inconnu, règle…)", content: { "application/json": { schema: ERROR } } },
        },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: "light-mcp-server", version, license: { name: "MIT", url: "https://opensource.org/licenses/MIT" }, description: "Toutes les actions du serveur lumière : la même couche de commandes que les outils MCP et les adresses OSC. Jeton : `POST /api/auth/login` (PIN) ou le jeton maître (`light token`)." },
    servers: [{ url: "http://localhost:8790" }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths,
  };
}

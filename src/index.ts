/**
 * Bootstrap (same shape as wing-mcp-server): machine config → EventBus → plugins → HTTP gateway
 * and/or stdio MCP endpoint.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthService, resolveAuthToken } from "./core/auth.js";
import { ConfigStore } from "./core/config-store.js";
import { EventBus } from "./core/event-bus.js";
import { Gateway } from "./core/gateway.js";
import { redirectConsoleToStderr, StdioEndpoint } from "./core/stdio-endpoint.js";
import { ToolVisibilityController } from "./core/tool-visibility-controller.js";
import { LightPlugin, PLUGIN_ID } from "./plugins/light/light-plugin.js";

export interface BootstrapOptions {
  configPath?: string;
  port?: number;
  host?: string;
  http?: boolean;
  stdio?: boolean;
  log?: (msg: string) => void;
}

export interface Running {
  gateway?: Gateway;
  stdio?: StdioEndpoint;
  light: LightPlugin;
  auth: AuthService;
  masterToken: string;
  stop(): Promise<void>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function bootstrap(opts: BootstrapOptions = {}): Promise<Running> {
  const log = opts.log ?? ((m: string) => console.error(m));
  if (opts.stdio) redirectConsoleToStderr();
  const configStore = new ConfigStore({ filePath: opts.configPath ?? process.env.LIGHT_CONFIG_PATH ?? path.join(ROOT, "data", "machine", "config.json") });
  await configStore.load();
  const masterToken = await resolveAuthToken(configStore);
  const auth = new AuthService(masterToken, configStore);
  const eventBus = new EventBus();
  const light = new LightPlugin({ eventBus, config: configStore.scoped(PLUGIN_ID), auth });
  const plugins = [light];
  const toolVisibility = new ToolVisibilityController(plugins, configStore);
  await light.start();

  let gateway: Gateway | undefined;
  if (opts.http !== false) {
    gateway = new Gateway({ plugins, eventBus, auth, toolVisibility, port: opts.port ?? Number(process.env.PORT ?? 8790), host: opts.host, webRoot: path.join(ROOT, "web", "dist"), log });
    await gateway.start();
  }
  let stdio: StdioEndpoint | undefined;
  if (opts.stdio) {
    stdio = new StdioEndpoint({ plugins, toolVisibility, onClientDisconnect: () => void running.stop().then(() => process.exit(0)) });
    await stdio.start();
  }
  const running: Running = {
    gateway,
    stdio,
    light,
    auth,
    masterToken,
    async stop() {
      await stdio?.stop();
      await gateway?.stop();
      await light.stop();
    },
  };
  return running;
}

import { cmd } from "./api";
import { control } from "./ws";
import { createCommandStore, type CommandStore, type CommandStoreOptions } from "./command-store";

/** A command store of the page (command-store.ts): api.ts's `cmd`, ws.ts's `control` and the window's timers. */
export function createPageStore<State, Answer>(options: CommandStoreOptions<State, Answer>): CommandStore<State> {
  return createCommandStore<State, Answer, number>(options, {
    cmd,
    control,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
  });
}

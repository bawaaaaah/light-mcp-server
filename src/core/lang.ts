/**
 * The language the server answers in (docs/decisions.md, « Messages du serveur ») : French by
 * default — the team's language, the CLI's and the AI clients' — or English for an interface set
 * to English, which says so with the `x-light-lang` header. Held for the whole request by
 * AsyncLocalStorage, so a message deep in a command picks it without passing it down.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type Lang = "fr" | "en";

const current = new AsyncLocalStorage<Lang>();

/** The language a request asks for (`x-light-lang`), when it is one the server speaks. */
export function langOf(header: string | string[] | undefined): Lang | undefined {
  const v = Array.isArray(header) ? header[0] : header;
  return v === "en" || v === "fr" ? v : undefined;
}

/** Runs `fn` answering in `lang` (French when absent), awaited work included. */
export function inLang<T>(lang: Lang | undefined, fn: () => T): T {
  return current.run(lang ?? "fr", fn);
}

/** The language of the request being answered. */
export const lang = (): Lang => current.getStore() ?? "fr";

/** A message in the language of the request being answered. */
export const say = (fr: string, en: string): string => (lang() === "en" ? en : fr);

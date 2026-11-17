import { createContext, useContext } from "react";
import type { Role } from "./api";

export type Page = "live" | "songs" | "show" | "venue" | "library" | "console" | "midi" | "osc" | "import" | "notes" | "files" | "connect" | "settings" | "account";

/** Opens another page from inside one (the getting-started guide, links between pages). */
export const Nav = createContext<(page: Page) => void>(() => undefined);
export const useNav = (): ((page: Page) => void) => useContext(Nav);
/** Who is signed in (role and rights), for a component that offers more to some. */
export const Me = createContext<Role | null>(null);
export const useMe = (): Role | null => useContext(Me);

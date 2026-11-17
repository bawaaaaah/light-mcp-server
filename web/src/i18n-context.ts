import { createContext, useContext } from "react";
import { TEXTS, type Texts } from "./i18n";

/** The texts of the language in use, given by the app to every component that shows words. */
export const I18n = createContext<Texts>(TEXTS.fr);
export const useT = (): Texts => useContext(I18n);

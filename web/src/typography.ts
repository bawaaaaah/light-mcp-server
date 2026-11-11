import { TEXTS, type Texts } from "./i18n";

/** The interface's language is French: « » quotes, a space before ? and :. */
export const isFrench = (t: Texts): boolean => t === TEXTS.fr;

/** A name in the interface's quotes: « Rigging » in French, “Rigging” in English. */
export const quoted = (t: Texts, text: string | number): string => (isFrench(t) ? `« ${text} »` : `“${text}”`);

/** The space French puts before ? and !, none in English. */
export const beforeMark = (t: Texts): string => (isFrench(t) ? " " : "");

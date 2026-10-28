import { settings } from "./settings.js";

/**
 * In-game text in both languages, side by side at the call site:
 * `t("블록 캐기", "Mine")`. Keeping the pair together means a new string can
 * never ship in one language only, and there is no key file to drift out of
 * step with the code. Korean is the default; switching reloads the page, so
 * nothing needs to re-render live.
 */
export const t = (ko: string, en: string): string => (settings.lang === "en" ? en : ko);

export const isEnglish = (): boolean => settings.lang === "en";

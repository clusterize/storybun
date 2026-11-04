/**
 * Emulates `prefers-color-scheme` inside the story frame of the dev UI, the
 * way a snapshot mode emulates it through Playwright. A browser offers no
 * page-level switch for it -- an iframe's `color-scheme` does not reach the
 * framed document's media queries -- so the frame rewrites them itself:
 *
 * - `matchMedia` answers `(prefers-color-scheme: …)` for the chosen scheme,
 *   for theme providers that read it from script;
 * - every `@media (prefers-color-scheme: …)` rule, and `<link media=…>`, in
 *   a same-origin stylesheet is rewritten to always or never apply, for
 *   styles that read it from CSS. Stylesheets added later are handled too.
 *
 * Runs as an inline script ahead of the frame bundle, because a theme
 * provider may call `matchMedia` once while its module loads. The scheme
 * comes from `?colorScheme=`; without it nothing is touched.
 */
export function installColorScheme(scheme: string | null): void {
  if (scheme !== "light" && scheme !== "dark" && scheme !== "no-preference") return;

  const mentions = /prefers-color-scheme/i;
  const feature = /\(\s*prefers-color-scheme\s*:\s*(light|dark|no-preference)\s*\)/gi;
  const always = "(min-width: 0px)";
  const never = "(max-width: 0px) and (min-width: 1px)";
  const rewrite = (query: string) =>
    query.replace(feature, (_m: string, value: string) => (value.toLowerCase() === scheme ? always : never));

  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => original(rewrite(String(query)));

  const done = new WeakSet<CSSStyleSheet>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule && mentions.test(rule.media.mediaText)) {
        rule.media.mediaText = rewrite(rule.media.mediaText);
      }
      // @layer, @supports, @container and nested @media hold rules of their own.
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) visit(nested);
    }
  };
  const sweep = () => {
    for (const sheet of Array.from(document.styleSheets)) {
      if (done.has(sheet)) continue;
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin: unreadable, left alone
      }
      if (mentions.test(sheet.media.mediaText)) sheet.media.mediaText = rewrite(sheet.media.mediaText);
      visit(rules);
      done.add(sheet);
    }
  };

  sweep();
  new MutationObserver(sweep).observe(document, { childList: true, subtree: true });
  document.addEventListener("load", sweep, true); // a <link> finished loading
  document.documentElement.dataset.storybunColorScheme = scheme;
}

/** The inline `<script>` the frame page starts with. */
export function colorSchemeScript(): string {
  return `(${installColorScheme.toString()})(new URLSearchParams(location.search).get("colorScheme"));`;
}

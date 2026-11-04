import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { installColorScheme } from "./color-scheme.ts";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

const STYLES = `
  body { color: rgb(0, 0, 1); }
  @media (prefers-color-scheme: dark) { body { color: rgb(0, 0, 2); } }
  @layer theme {
    @media screen and (prefers-color-scheme: dark) { p { color: rgb(0, 0, 3); } }
  }
`;

/** A page whose system scheme is `system`, emulating `scheme` the way the story frame does. */
async function pageWith(system: "light" | "dark", scheme: string | null): Promise<Page> {
  const page = await browser.newPage({ colorScheme: system });
  await page.addInitScript(`(${installColorScheme.toString()})(${JSON.stringify(scheme)})`);
  // Init scripts run on navigation, which `setContent` is not; serve the page instead.
  await page.route("http://storybun.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: `<style>${STYLES}</style><p>x</p>` }),
  );
  await page.goto("http://storybun.test/");
  return page;
}

async function read(page: Page) {
  return page.evaluate(() => ({
    script: window.matchMedia("(prefers-color-scheme: dark)").matches,
    body: getComputedStyle(document.body).color,
    layered: getComputedStyle(document.querySelector("p")!).color,
  }));
}

describe("installColorScheme (real chromium)", () => {
  test("dark on a light system: matchMedia and CSS rules, inside @layer too, follow dark", async () => {
    const page = await pageWith("light", "dark");
    expect(await read(page)).toEqual({ script: true, body: "rgb(0, 0, 2)", layered: "rgb(0, 0, 3)" });
    await page.close();
  });

  test("light on a dark system: dark rules no longer apply", async () => {
    const page = await pageWith("dark", "light");
    expect(await read(page)).toEqual({ script: false, body: "rgb(0, 0, 1)", layered: "rgb(0, 0, 1)" });
    await page.close();
  });

  test("a stylesheet added after load is rewritten too", async () => {
    const page = await pageWith("light", "dark");
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "@media (prefers-color-scheme: dark) { p { background: rgb(9, 9, 9); } }";
      document.head.append(style);
    });
    await page.waitForFunction(() => getComputedStyle(document.querySelector("p")!).backgroundColor === "rgb(9, 9, 9)");
    await page.close();
  });

  test("no scheme leaves the system preference alone", async () => {
    const page = await pageWith("dark", null);
    expect(await read(page)).toEqual({ script: true, body: "rgb(0, 0, 2)", layered: "rgb(0, 0, 3)" });
    await page.close();
  });
});

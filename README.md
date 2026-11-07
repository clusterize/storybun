# storybun

A fast, zero-config component explorer built on [Bun](https://bun.sh). Think Storybook, but instant.

## Features

- **Instant startup** — Bun-native bundling, no Webpack/Vite overhead
- **Zero config** — Scans `**/*.stories.tsx` files out of the box
- **Hot reload** — WebSocket-based live reload on file changes
- **Monorepo support** — Discovers packages automatically, per-package config and wrappers
- **Customizable UI** — Replace Layout, Sidebar, or Wrapper components
- **Style isolation** — Each story renders in its own iframe: its global CSS, portals and overlays stay out of the UI around it
- **Modes and viewports** — Switch the story between your snapshot `modes` (light/dark), or show them side by side, at any viewport
- **Dark/light theme** — The UI itself follows system preference
- **Component catalogue** — `storybun components` lists and searches the components your stories show, with import paths, doc comments and variants

## Quick Start

```bash
bun install storybun
```

Create a story file:

```tsx
// src/Button.stories.tsx
import { Button } from "./Button";

export const Primary = () => <Button>Click me</Button>;
export const Secondary = () => <Button variant="secondary">Click me</Button>;
```

Run the dev server:

```bash
bunx storybun
```

Open [http://localhost:5175](http://localhost:5175).

## CLI

```
storybun                       Start the dev server
storybun snapshot [options]    Capture every story and compare against its baseline
storybun list [options]        Print every story key
storybun shot <story> [opts]   Write a PNG of one story, leaving baselines untouched
storybun components [query]    List the components stories demonstrate, or search them
```

## Story Format

Each `.stories.tsx` file exports named components. Every named export becomes a story:

```tsx
// Card.stories.tsx
import { Card } from "./Card";

export const Default = () => <Card>Hello</Card>;
export const WithImage = () => <Card image="/hero.png">Hello</Card>;
```

The sidebar tree is derived from file paths — `src/components/Card.stories.tsx` becomes `Components/Card`.

## The dev UI

Groups start collapsed, except the way to the open story; a run of folders
with nothing else in them is shown as one row (`src/components/forms`), and
each group shows how many stories it holds. Typing in the search box (`⌘K`)
lists matching stories directly, best match first: every word you type has to
appear in the story key, and a match in the story's name ranks above one in
its path. `↑`/`↓` and `↵` pick a result. Drag the sidebar's edge to resize it.

The toolbar above the story switches between the `modes` of your snapshot
config and can show all of them side by side, so a dark theme is one click
away and never needs a toggle inside a story. It also sizes the story to one
of your snapshot `viewports` or a phone/tablet preset. The URL keeps the
story, mode and viewport, so a link opens the same view.

| Key | |
| --- | --- |
| `⌘K` / `ctrl+K` | search |
| `⌥↑` / `⌥↓` | previous / next story |
| `r` | reload the story |

The keys work while the story has focus, too.

Each story renders alone in an iframe (`/frame.html?story=<key>`), so its
global styles, portals and overlays stay out of the sidebar. The "open in new
tab" button opens that page directly.

A mode's `colorScheme` is emulated inside the frame: `matchMedia` answers for
it, and `@media (prefers-color-scheme: …)` rules in same-origin stylesheets
are rewritten to match. Browsers offer no page-level switch for the setting,
so rules a stylesheet adds later through `insertRule`, and cross-origin
stylesheets, keep following the system. A theme provider that prefers a
choice saved in `localStorage` over the system setting will still show the
saved theme; in snapshots every run starts with empty storage.

## Component Catalogue

Your stories already know which components exist and what they look like.
`storybun components` turns that into a catalogue you, or a coding agent, can
query from the terminal instead of grepping for a component and its import path:

```bash
storybun components                    # one line per component: name, import path, summary
storybun components badge              # best matches in full
storybun components "status label"     # free text: names, paths, doc comments, variants
storybun components --json             # the whole catalogue, machine-readable
```

```
Badge
  import { Badge } from '@acme/kit/ui'
  import { Badge } from '@/ui/badge'  (inside @acme/kit)
  source  packages/kit/src/ui/badge.tsx:21

  A short status label.

  tone: plain* | danger
    plain — Neutral facts: counts, labels.
    danger — Something went wrong and needs a look.
  size: sm | md*

  stories
    @acme/kit/Ui/Badge--Badge  — The default tone.
    @acme/kit/Ui/Badge--BadgeDanger
```

Nothing is configured and nothing runs: the catalogue is read from source with
the TypeScript parser (an optional peer dependency every `.tsx` project already
has), in a few seconds for a few hundred story files.

**Which component a story file shows.** A story file is credited with the
components it imports from the module it is named after (`badge.stories.tsx`
→ `./badge`), whether it renders them or hands them to a helper. If it imports
none, it is credited with every component it renders from a relative import,
except files that look like fixtures or harnesses (`_story-fixtures.tsx`,
`*.fixture.ts`). Each story export is then listed under the components it
actually renders. When a file only reaches its component through a harness,
name it in a doc comment above the first import:

```tsx
/** @component JobBoard */
import { Harness } from "./_story-fixtures";
```

`@component` takes a name imported by the file or exported by its same-named
module, or `<specifier>#<Name>` (`@component ./board#JobBoard`). Files that
show no component are counted on stderr.

**What it reads.** Everything comes from comments you would write anyway:

- **Description**: the doc comment on the component's declaration (`/** … */`
  above `function Badge` or `export const Badge`), followed through barrels and
  re-exports. `@deprecated` is shown first.
- **Variants**: a `cva(...)` / `tv(...)`-style config the component uses, with
  its `defaultVariants`. A doc comment on a variant axis or value is shown next
  to it, which is the place for *when to use which*:

  ```ts
  const badgeVariants = cva("badge", {
    variants: {
      tone: {
        /** Neutral facts: counts, labels. */
        plain: "…",
        /** Something went wrong and needs a look. */
        danger: "…",
      },
    },
  });
  ```

- **Import paths**: `import` is the package.json `exports` entry other packages
  use (the declaring file itself or a barrel re-exporting it; the shortest
  wins). `localImport` is the tsconfig `paths` alias the declaring package uses
  for its own files.
- **Stories**: their keys (for `storybun shot`), the doc comment on each story
  export, and the paths of existing baselines.

## Configuration

Create `storybun.config.ts` in your project root:

```ts
import type { StorybunConfig } from "storybun";

export default {
  // Glob patterns for story files (default: ["**/*.stories.tsx"])
  stories: ["src/**/*.stories.tsx"],

  // Dev server port (default: 5175)
  port: 3000,

  // Bun plugins applied during build
  plugins: [],

  // Override UI components. Layout and Sidebar render in the dev UI; the
  // Wrapper renders inside the story iframe, around every story.
  components: {
    Layout: "./src/storybun/Layout.tsx",
    Sidebar: "./src/storybun/Sidebar.tsx",
    Wrapper: "./src/storybun/Wrapper.tsx",
  },
} satisfies StorybunConfig;
```

### Visual Snapshots

`bunx storybun snapshot` renders every story in headless Chromium and compares it
against the baseline in `outDir`, writing `<story>.actual.png` and
`<story>.diff.png` for anything that moved. `--update` accepts the current render
as the new baseline and deletes baselines that no story produces anymore
(unless `--filter` narrowed the run), so a renamed or deleted story does not
leave its old image behind.

Each image is cropped to the story's own box: what the story rendered, plus
anything it portaled next to the app root, so a menu, popover or dialog rendered
open is captured together with its trigger. The wrapper's own chrome around the
story stays out of the picture.

Each snapshot captures the story's own content, cropped to its own box — not
the viewport and not the wrapper. The wrapper still renders around it (theme
context, providers, stylesheets), it just isn't part of the captured pixels.

```ts
export default {
  snapshot: {
    // Where baselines live (default: "__snapshots__")
    outDir: "__snapshots__",

    // Per-pixel colour sensitivity for pixelmatch, 0 to 1 (default: 0.1).
    // Lower is stricter. It decides whether a pixel counts as different, not
    // how many may differ.
    threshold: 0.1,

    // Differing pixels a story may have and still pass (default: 0). Chromium
    // rasterises a few edge pixels differently from one machine to the next --
    // the antialiased seam of overlapping clipped images, say -- and without a
    // budget those read as a change on every other CI run. A real change
    // touches far more pixels than a small budget lets through.
    maxDiffPixels: 0,

    // Viewport sizes to render each story at before capture (default: one
    // 1280x720 viewport). The captured image is cropped to the story's own
    // content, not this size — a narrow or short story still produces a
    // narrow or short PNG regardless of viewport.
    viewports: [{ width: 1280, height: 720 }],

    // Hard cap in ms on how long a story may take to settle (default: 10000).
    // Not a sleep: a capture is taken as soon as the story is settled (see
    // "Readiness" below) and fails loudly if it still is not at the cap.
    settleTimeout: 10_000,

    // Pages captured in parallel (default: 4)
    concurrency: 4,

    // Freeze `Date.now()` and `new Date()` at this instant. Without it, any
    // story that renders a relative timestamp ("6 minutes ago") or a ticking
    // duration diffs against its own baseline on every run.
    clock: "2026-07-30T12:00:00.000Z",

    // Page timezone and locale, fixed so local runs match CI
    timezoneId: "UTC",
    locale: "en-US",

    // Environments every story is captured in, on top of `viewports`. Each
    // story is captured once per mode and the mode name is appended to the
    // baseline filename (`Button--Primary-dark.png`). Unset captures each
    // story once, unsuffixed.
    modes: {
      light: { colorScheme: "light" },
      dark: { colorScheme: "dark" },
    },
  },
} satisfies StorybunConfig;
```

A mode changes what the browser reports to the page -- `prefers-color-scheme`,
and optionally a `locale` or `timezoneId` override -- never what a story renders
on its own. It is meant for a theme that follows the OS preference: with the two
modes above every story gets a light and a dark baseline without a story per
theme. A theme read from storage instead of the media query does not react to a
mode, and needs a Wrapper that maps the mode onto it.

Turning modes on renames every baseline once (`X.png` becomes `X-light.png` and
`X-dark.png`); the unsuffixed files are left in place and can be deleted.

Timers keep running under `clock` — only the reported time is frozen — so a
component polling on an interval simply re-renders the same output. Story
fixtures should therefore express timestamps at or before the frozen instant, so
that relative labels read as the past.

### Readiness

A capture is taken when the story is *settled*, not after a fixed delay. After
the generated entry signals its first paint, the page is polled until all of
this holds, and the screenshot is retaken until two in a row are identical:

- the story has committed to the DOM with a measurable box (a story that
  renders `null` until its data arrives is waited for, not captured empty);
- `window.__storybunPending` is zero (see below);
- every `<iframe>` with a `src` or `srcdoc` has loaded its document, and in
  the page as well as in every same-origin framed document, fonts are loaded
  and every `<img>` is complete and decoded;
- no animation is running;
- nothing in the DOM changed and the story's box did not move across two
  consecutive frames.

A story that is still not settled after `settleTimeout` fails its capture with
a message naming the story and the condition it was waiting on, and the run
goes on with the next story. Nothing falls back to a blank or partial image.

**`window.__storybunPending`.** The page cannot see a re-render that has not
happened yet: a component that shows a skeleton for 300ms and then swaps in its
data looks finished the whole time. Your Wrapper can tell storybun about work
in flight by keeping `window.__storybunPending` at the number of pending
operations, or by assigning it a function that returns that number. Capture
waits while it is above zero. With TanStack Query, for example:

```tsx
window.__storybunPending = () => queryClient.isFetching() + queryClient.isMutating();
```

**Motion.** Every capture runs with `prefers-reduced-motion: reduce` emulated,
so motion libraries and stylesheets that honour the preference switch their
animation off on their own; CSS animations and transitions are additionally
forced to zero duration as a backstop. A finite animation that still runs (a
Web Animations API fade, say) is waited for. One that would never end -- a
spinner with infinite iterations -- is paused at its first frame so the story
can settle, and settles on the same frame every run. Enabling reduced motion
is a one-time re-baseline for components that render differently under it.

**Knowing you are under capture.** The snapshot document carries
`data-storybun-snapshot` on `<html>` from before any script runs, so a Wrapper
that must behave differently under capture checks
`document.documentElement.hasAttribute("data-storybun-snapshot")` rather than
guessing from the URL.

**`waitTimeout`** is deprecated and ignored. It was a blind sleep after the
first-paint signal; the readiness contract replaces it. A config that still
sets it prints a warning once.

### Progress and timing

The run logs each phase with its duration and one line per finished capture.
Each capture is compared against its baseline (or, with `--update`, written)
by the worker that took it, as soon as it exists, so there is no separate
compare pass afterwards, only the captures in flight are held in memory, and a
story's outcome shows on its own line:

```
Capturing 618 snapshots (309 stories in 42 files × 2 modes) with concurrency 4
[  1/618] Components/Button--Primary [light] 830ms
[  2/618] Components/Card--Wide [light] 910ms changed 3.2%
[  3/618] Components/Card--Wide [dark] 870ms + new
[  4/618] ✗ Timeline--Empty [light] 10.0s: story did not settle within 10000ms: the DOM changed between two frames (2 mutation(s))
...
Captured and compared in 1m32s
```

`--quiet` (`-q`) drops the per-capture lines; failures, phases and the summary
stay.

### Reports

`snapshot` prints its result to stdout. Two flags add a machine-readable and a
browsable copy of the same run; without them nothing new is written.

```bash
storybun snapshot --json                  # <outDir>/report.json
storybun snapshot --html                  # <outDir>/report.html
storybun snapshot --json --html           # both
storybun snapshot --json out/r.json --html docs/snapshots.html
```

Both are opt-in and change nothing else: baseline adoption, `--update` and the
exit code stay exactly as they are. A path is relative to the project root.

`report.json` has one entry per story x mode x viewport, plus one per baseline
in `outDir` that no story of this run produced:

```jsonc
{
  "version": 1,
  "generatedAt": "2026-09-29T10:58:04.312Z",
  "outDir": "__snapshots__",
  "commit": "abcdef1...",           // GITHUB_SHA when set, else null
  "images": "all",                  // --report-images: all | review
  "summary": { "total": 6, "passed": 0, "changed": 4, "new": 0, "removed": 2, "captureFailed": 0, "updated": 0, "exitCode": 1 },
  "config": { "threshold": 0.1, "viewports": [{ "width": 1280, "height": 720 }], "modes": ["light", "dark"],
              "clock": "2026-07-30T12:00:00.000Z", "locale": "en-US", "timezoneId": "UTC" },
  "results": [
    {
      "storyKey": "Components/Button--Primary",
      "mode": "dark",                                   // null without modes
      "viewport": { "width": 1280, "height": 720 },
      "status": "changed",                              // pass | changed | new | removed | capture-failed | updated
      "diffPercent": 12.5,                              // null when nothing was compared
      "dimensions": { "baseline": { "width": 120, "height": 40 }, "actual": { "width": 160, "height": 40 } },
      "files": {                                        // relative to outDir; only files that exist after this run
        "baseline": "Components--Button--Primary-dark.png",
        "actual": "Components--Button--Primary-dark.actual.png",
        "diff": null                                    // null when the dimensions differ: no diff image exists then
      },
      "error": null                                     // first line of the capture error for capture-failed
    }
  ]
}
```

How each outcome appears:

- **new** -- no baseline existed; the render was adopted, and `files.baseline` is
  that freshly written image. No `.actual.png` is written for it.
- **changed** -- `files.baseline` is the old image, `files.actual` the new one,
  `files.diff` the pixelmatch output, or `null` when the dimensions changed.
- **removed** -- a `<key>.png` in `outDir` that no story produced anymore. A
  comparison run reports it and leaves it in place; an `--update` run deletes
  it (with any stale `.actual.png` / `.diff.png`) after the report is built, and
  its entry then lists no file. Never affects the exit code. `storyKey` is the
  filename stem, since the story it belonged to is gone. Not reported, and never
  deleted, under `--filter`, where skipped stories are intended.
- **capture-failed** -- the story could not be captured; `error` says why.
- **updated** -- every capture of an `--update` run.

Results are sorted by story key, then mode, then viewport. `summary.exitCode`
is the exit code of the run, so a consumer never has to recompute it.

`report.html` is one self-contained page: inline CSS and script, no external
requests, readable in light and dark. It has one section per status --
changed, new, capture failed, removed -- linked from the top bar as plain
anchors (`report.html#changed`); passed and updated captures are folded away
at the end. A changed capture opens on a before/after slider, with tabs for
before, after and diff in three columns, and for one image at a time in the
same spot, so flipping between "before" and "after" makes the change jump
out. Images are shown at full height and never scaled up. Image paths are
relative to the HTML file, so it works opened from `outDir` and served from a
bucket next to the PNGs.

When the run had more than one mode, the page shows one at a time, full
width; the switch (or `m`) changes it and the counts follow. The mode is kept
in the query string (`report.html?mode=dark#changed`), so a link opens the
same view. A filter box narrows the page to matching story keys. Any image
opens full screen, and from there the arrow keys step through every capture
on the page:

| Key | Page | Full screen |
| --- | --- | --- |
| `/` | focus the story filter | |
| `m` | next mode | |
| `j` / `k` | next / previous story | next / previous capture |
| `f`, `Enter` | open the current story full screen | |
| `←` / `→` | | next / previous capture |
| `space` | | flip between before and after |
| `s` `g` `b` `a` `d` | | slider, side by side, before, after, diff |
| `esc` | leave the filter | close |

Without JavaScript the page still shows every image, every mode and the
comparison tabs; only the mode switch, the filter, the slider's divider and
the full-screen view need it.

#### Publishing only the images that need a look

Most captures of a typical run pass, and a passed capture's image is just its
baseline. `--report-images review` tells the reports that only the images of
changed, new and removed captures will be published next to them:

```bash
storybun snapshot --json --html --report-images review
```

`report.json` still lists every entry and every file, and records
`"images": "review"`. `report.html` shows a passed (or updated) capture as its
badge and a "not published" note instead of an image, so the page has no broken
images when served from a bucket that holds only the rest. `filesToPublish(report)`,
exported from `storybun`, returns exactly the files the page shows, relative to
`outDir`; upload those. The default, `all`, shows every image as before.

#### Custom HTML template

The page is rendered from a React component that receives the report. Point
`snapshot.report.component` at your own to replace it:

```ts
// storybun.config.ts
export default {
  snapshot: {
    report: { component: "./storybun/Report.tsx" },
  },
};
```

```tsx
// storybun/Report.tsx
import type { ReportTemplateProps } from "storybun";
import { DefaultReport } from "storybun";

export default function Report({ report, imagePrefix }: ReportTemplateProps) {
  if (report.summary.changed === 0) return <html><body>Nothing changed.</body></html>;
  return <DefaultReport report={report} imagePrefix={imagePrefix} />;
}
```

`imagePrefix` turns a `files.*` path into an `img src` relative to the HTML
file; a template that shows images should skip the entries for which
`imagesPublished(report, entry)` (exported from `storybun`) is false. The component is rendered once, in Bun, with `renderToStaticMarkup`:
there is no browser, so no state, effects or event handlers. Interactivity has
to come from static HTML (`<details>`, anchors) or an inline `<script>` string
the template emits itself. The default export or a named `Report` export is used.

### GitHub Action

The repository doubles as a composite action that runs `snapshot --json --html`,
publishes the snapshot directory to an S3-compatible bucket (Cloudflare R2
included) and keeps one sticky comment on the pull request up to date. Bun and
`bun install` are the caller's job, as is restoring the baselines; the action
owns everything after that.

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v4
  - uses: oven-sh/setup-bun@v2
  - run: bun install --frozen-lockfile

  - uses: actions/cache/restore@v4
    with:
      path: __snapshots__
      key: snapshots-main-${{ github.sha }}
      restore-keys: snapshots-main-

  - uses: clusterize/storybun@v1
    id: snapshots
    with:
      s3-bucket: gh-issue-assets
      s3-endpoint: https://${{ secrets.CF_ACCOUNT_ID }}.r2.cloudflarestorage.com
      public-base-url: https://assets.example.com
      aws-access-key-id: ${{ secrets.R2_ACCESS_KEY_ID }}
      aws-secret-access-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

Every run writes both reports, adds a job summary with the counts, and exposes
them as outputs (`exit-code`, `needs-review`, `changed`, `new`, `removed`,
`capture-failed`, `report-url`, ...). When a bucket is configured the images go
up under `pr-<number>/<sha>/` (`<ref>/<sha>/` outside pull requests) with the
two report files next to them, so the relative image paths in `report.html`
resolve unchanged; the comment links to `<public-base-url>/<prefix>/report.html`.
By default that happens only when something needs a look (`publish: always`
changes it), and only the images of changed, new and removed captures are
uploaded: the action runs with `--report-images review`, so the published page
shows passed captures without an image. On a large suite that skips thousands
of unchanged baselines per run; `publish-images: all` uploads every image the
report shows instead. The step fails when the run exits non-zero, i.e. on changed stories
or capture failures; `fail-on-changes: false` turns that into an output only.

On the main branch, `update: true` runs `--update` so a following
`actions/cache/save` step stores the refreshed baselines, with the baselines of
deleted or renamed stories pruned. Inputs cover the
working directory, the storybun command, extra arguments such as
`--codeowners`, the snapshot directory (it must match `snapshot.outDir`), and
whether to install Chromium; see `action.yml` for the full list.

### Single Snapshots

`storybun snapshot` is a regression check: it owns `outDir` and rewrites what it
finds there. When you just want a picture of one component -- to eyeball a change,
attach to a review, or hand to a tool that cannot drive a browser -- use `shot`,
which writes exactly where you point it and never reads or replaces a baseline.

```bash
storybun list                                   # every story key
storybun list --filter Button --json            # machine-readable, narrowed

storybun shot 'Components/Button--Primary' -o button.png
storybun shot Primary --viewport 800x600        # unique substrings resolve too
storybun shot 'Components/Button--Primary' --mode dark
```

The key is `<story path>--<export>`, exactly as `list` prints it. A query that
matches nothing, or matches more than one story, exits non-zero and lists the
candidates rather than guessing.

The image is what the baseline run would write for that story: the same
wrappers, plugins, frozen `clock`, `timezoneId` and `locale`, and the same crop
to the story's own rendered box rather than the whole viewport. With `modes`
configured, `--mode` picks one; omitted, the first configured mode is used, and
the default filename carries the same `-<mode>` suffix as the baseline
(`Components--Button--Primary-dark.png`). Playwright is still required; `shot`
only saves you from driving it.

### Monorepo / Per-Package Config

In a monorepo, storybun discovers each story's nearest `package.json` and groups stories by package. Each package can have its own `storybun.config.ts` with per-package plugins and a custom `Wrapper`:

```ts
// packages/design-system/storybun.config.ts
export default {
  plugins: [/* package-specific Bun plugins */],
  components: {
    Wrapper: "./src/ThemeWrapper.tsx",
  },
};
```

## Custom Components

### Wrapper

Wraps each story. Useful for providing theme context or global styles:

```tsx
export function Wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
```

### Layout

Controls the overall page structure (sidebar + content area).

### Sidebar

Controls the story navigation tree.

## License

MIT

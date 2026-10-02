export default { title: "Fixtures/Media" };

// `/slow.png` and `/slow.html` are served by the test's own server with a
// delay, so each arrives well after the entry's ready signal.

/** A sized image that is still loading at first paint. */
export const Image = () => (
  <img src="/slow.png" width={120} height={80} style={{ display: "block" }} />
);

/** A document rendered into `srcdoc`, as a mail preview is. */
export const SrcDocFrame = () => (
  <iframe
    srcDoc="<body style='margin:0;background:#0000ff'></body>"
    style={{ width: 200, height: 100, border: 0, display: "block" }}
  />
);

/** A framed document fetched from the network. */
export const SlowFrame = () => (
  <iframe src="/slow.html" style={{ width: 200, height: 100, border: 0, display: "block" }} />
);

/**
 * A framed document with its own web font and image, as a mail preview has.
 * The font is applied once the framed document has loaded, as a lazily
 * requested subset or a late stylesheet does, so the frame's `load` event
 * has fired while the font is still on its way; the image, by contrast,
 * holds `load` back.
 */
export const FrameWithResources = () => (
  <iframe
    srcDoc={`<!doctype html><style>
      @font-face { font-family: Slow; src: url(/slow-font.ttf); }
      body { margin: 0; background: #ffffff; font-family: monospace; font-size: 24px; }
      body.late { font-family: Slow, monospace; }
    </style><body>Framed text<br><img src="/slow.png" width="120" height="80">
    <script>addEventListener("load", () => { document.body.className = "late"; });</script></body>`}
    style={{ width: 200, height: 160, border: 0, display: "block" }}
  />
);

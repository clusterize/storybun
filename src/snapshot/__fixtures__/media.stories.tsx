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

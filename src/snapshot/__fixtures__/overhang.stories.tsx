export default { title: "Fixtures/Overhang" };

// A fixed-position root pinned past the document's bottom raster edge, with
// nothing else in the document to grow its scroll height: the exact shape
// Playwright's `page.screenshot({ fullPage: true, clip })` silently crops to
// the raster instead of the requested box (see capture.ts's
// `captureClippedRegion`).
export const BottomOverhang = () => (
  <div
    style={{
      position: "fixed",
      left: 0,
      top: 150,
      width: 100,
      height: 100,
      background: "rgb(239, 68, 68)",
    }}
  />
);

// Same shape, overhanging the right edge instead of the bottom.
export const RightOverhang = () => (
  <div
    style={{
      position: "fixed",
      left: 50,
      top: 0,
      width: 100,
      height: 80,
      background: "rgb(245, 158, 11)",
    }}
  />
);

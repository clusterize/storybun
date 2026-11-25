export default { title: "Fixtures/Scheme" };

// tsconfig has no "dom" lib; declare the one global this fixture touches.
declare const window: any;

// Paints solid green under a dark `prefers-color-scheme` and solid red under
// light. Reads the media query directly so the test exercises exactly what a
// snapshot mode emulates, with no theme machinery in between.
export const Swatch = () => {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return (
    <div
      style={{
        width: 100,
        height: 60,
        background: dark ? "#00ff00" : "#ff0000",
      }}
    />
  );
};

// Left half: a stylesheet media query, which follows the scheme whenever it
// changes. Right half: the scheme as it was when the story first rendered.
// On a page of its own under a dark scheme both halves are green; on a page
// that was loaded light and then switched to dark, only the left one is.
export const LiveAndAtMount = () => {
  const darkAtMount = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return (
    <div style={{ display: "flex", width: 100, height: 60 }}>
      <style>{`.live { background: #ff0000 } @media (prefers-color-scheme: dark) { .live { background: #00ff00 } }`}</style>
      <div className="live" style={{ width: 50, height: 60 }} />
      <div style={{ width: 50, height: 60, background: darkAtMount ? "#00ff00" : "#ff0000" }} />
    </div>
  );
};

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

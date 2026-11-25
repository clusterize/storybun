import { useState } from "react";

export default { title: "Fixtures/Fonts" };

// `/slow-font.ttf` is served by the test's own server with a delay. The face
// is declared when this module loads, as an app's stylesheet declares its
// fonts, but nothing uses it until the story renders.
const style = document.createElement("style");
style.textContent = "@font-face { font-family: Slow; src: url(/slow-font.ttf); }";
document.head.append(style);

/**
 * A component that measures text once, during its first render, as a chart
 * sizing its axis from its labels does. Green when the web font was there to
 * measure with, red when the measurement ran against the fallback.
 */
export const MeasuredAtFirstRender = () => {
  const [ready] = useState(() => document.fonts.check("16px Slow"));
  return (
    <div style={{ width: 200, height: 100, background: ready ? "#00ff00" : "#ff0000", fontFamily: "Slow" }}>
      text
    </div>
  );
};

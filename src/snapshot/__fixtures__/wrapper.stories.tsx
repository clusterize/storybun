import React, { useContext } from "react";
import { ThemeContext } from "./wrapper-context.ts";

export default { title: "Fixtures/Wrapper" };

// Green only if the wrapper's context provider actually wraps this story;
// black if the story is rendered with no wrapper above it in the tree.
export const ContextStory = () => (
  <div
    style={{
      width: 60,
      height: 60,
      background: useContext(ThemeContext) === "provided" ? "rgb(0, 255, 0)" : "rgb(0, 0, 0)",
    }}
  />
);

// Green only via wrapper.css's `.storybun-fixture-wrapper .storybun-fixture-target`
// rule, which only matches when a real `.storybun-fixture-wrapper` ancestor
// is present in the DOM -- i.e. when the wrapper actually rendered.
export const CssStory = () => (
  <div className="storybun-fixture-target" style={{ width: 60, height: 60, background: "rgb(0, 0, 0)" }} />
);

// A full-width, fixed-height box that opaquely covers its own marker box, so
// any wrapper chrome leaking into the capture (padding, background, the
// absolutely-positioned button, the toaster) would show as an unexpected
// color or push the captured dimensions past the story's own box.
export const ChromeStory = () => (
  <div style={{ width: "100%", height: 60, background: "rgb(10, 20, 30)", boxSizing: "border-box" }} />
);

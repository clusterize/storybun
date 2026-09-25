import type React from "react";

// The inner element is what gets centered (see `.storybun-story` in
// styles.css). Centering the children directly would give a story that
// renders a fragment one auto-margin per root and spread them across the
// pane instead of keeping them together.
export function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="storybun-wrapper">
      <div className="storybun-story">{children}</div>
    </div>
  );
}

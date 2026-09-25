import React from "react";
import { createPortal } from "react-dom";

// tsconfig has no "dom" lib; declare the one global this fixture touches.
declare const document: any;

export default { title: "Fixtures/Portal" };

// A trigger in the tree plus content portaled to document.body at a fixed
// spot, the shape of every open menu, popover and dialog. The capture must
// span both, not just the trigger.
export const OpenMenu = () => (
  <>
    <div style={{ width: 60, height: 30, background: "rgb(0, 0, 255)" }} />
    {createPortal(
      <div
        style={{
          position: "fixed",
          left: 300,
          top: 200,
          width: 100,
          height: 50,
          background: "rgb(255, 0, 255)",
        }}
      />,
      document.body,
    )}
  </>
);

// A fixed-position element inside the story tree (a toast, a banner): its
// ancestors' boxes do not include it, so it must be measured on its own.
export const FixedBanner = () => (
  <div style={{ width: 60, height: 30, background: "rgb(0, 0, 255)" }}>
    <div
      style={{
        position: "fixed",
        left: 300,
        top: 200,
        width: 100,
        height: 50,
        background: "rgb(255, 0, 255)",
      }}
    />
  </div>
);

// Nothing inline at all, the shape of a dialog story: the capture is the
// portaled content alone.
export const PortalOnly = () =>
  createPortal(
    <div
      style={{
        position: "fixed",
        left: 300,
        top: 200,
        width: 100,
        height: 50,
        background: "rgb(255, 0, 255)",
      }}
    />,
    document.body,
  );

// A portal that mounts nothing visible (a closed overlay's empty container)
// must not widen the capture beyond the story's own box.
export const EmptyPortal = () => (
  <>
    <div style={{ width: 60, height: 30, background: "rgb(0, 0, 255)" }} />
    {createPortal(<div />, document.body)}
  </>
);

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

// A portal whose container has no box of its own, with the popup positioned
// absolutely inside it: the shape Base UI mounts. The popup must still count.
export const NestedPortal = () => (
  <>
    <div style={{ width: 60, height: 30, background: "rgb(0, 0, 255)" }} />
    {createPortal(
      <div>
        <div
          style={{
            position: "absolute",
            left: 300,
            top: 200,
            width: 100,
            height: 50,
            background: "rgb(255, 0, 255)",
          }}
        />
      </div>,
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

// A fixed list with no height of its own and an absolutely positioned item
// inside it: the shape of a toaster. The item must still count.
export const FixedContainer = () => (
  <div style={{ width: 60, height: 30, background: "rgb(0, 0, 255)" }}>
    <ol style={{ position: "fixed", left: 300, top: 200, width: 100, height: 0, margin: 0, padding: 0 }}>
      <li
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 100,
          height: 50,
          listStyle: "none",
          background: "rgb(255, 0, 255)",
        }}
      />
    </ol>
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

// Helpers a library parks off the page: a span 20,000px above it to measure
// text in, a visually hidden label far to its left. Nobody can scroll there,
// so neither may stretch the capture out to itself.
export const OffPageHelpers = () => (
  <>
    <div style={{ width: 60, height: 30, background: "rgb(0, 0, 255)" }} />
    {createPortal(
      <span aria-hidden="true" style={{ position: "absolute", top: -20000, left: 0, whiteSpace: "pre" }}>
        measured text
      </span>,
      document.body,
    )}
    {createPortal(
      <span style={{ position: "absolute", top: 0, left: -9999, width: 200, height: 20 }}>hidden label</span>,
      document.body,
    )}
  </>
);

// A banner that hangs over the top edge of the page: the part on the page is
// seen, the part above it is not.
export const OverTheTopEdge = () => (
  <>
    <div style={{ width: 60, height: 30, background: "rgb(0, 0, 255)" }} />
    {createPortal(
      <div
        style={{
          position: "fixed",
          left: 0,
          top: -20,
          width: 100,
          height: 50,
          background: "rgb(255, 0, 255)",
        }}
      />,
      document.body,
    )}
  </>
);

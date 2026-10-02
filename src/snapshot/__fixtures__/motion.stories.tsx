import { useEffect, useRef } from "react";

export default { title: "Fixtures/Motion" };

// tsconfig has no "dom" lib; declare the globals this fixture touches.
declare const window: any;
declare const document: any;

/** Fades in over 400ms with the Web Animations API, which no CSS override touches. */
export const FadeIn = () => {
  const ref = useRef<any>(null);
  useEffect(() => {
    ref.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: "forwards" });
  }, []);
  return <div ref={ref} style={{ width: 200, height: 100, background: "#00ff00", opacity: 0 }} />;
};

/**
 * Spins forever. Red on the left and blue on the right at its first frame,
 * anything else at any other moment, so the capture tells whether it was
 * frozen at the start or taken mid-spin.
 */
export const Spinner = () => {
  const ref = useRef<any>(null);
  useEffect(() => {
    ref.current.animate(
      [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
      { duration: 1000, iterations: Infinity },
    );
  }, []);
  return (
    <div
      ref={ref}
      style={{
        width: 100,
        height: 100,
        background: "linear-gradient(to right, #ff0000 50%, #0000ff 50%)",
      }}
    />
  );
};

/** Green when the page prefers reduced motion, red otherwise. */
export const ReducedMotion = () => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return <div style={{ width: 100, height: 60, background: reduce ? "#00ff00" : "#ff0000" }} />;
};

/** Green when the page carries the documented snapshot flag, red otherwise. */
export const SnapshotFlag = () => {
  const flagged = document.documentElement.hasAttribute("data-storybun-snapshot");
  return <div style={{ width: 100, height: 60, background: flagged ? "#00ff00" : "#ff0000" }} />;
};

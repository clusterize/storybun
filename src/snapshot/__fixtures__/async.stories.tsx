import React, { Suspense, lazy, useEffect, useState } from "react";

export default { title: "Fixtures/Async" };

// tsconfig has no "dom" lib; declare the globals this fixture touches.
declare const window: any;
declare const requestAnimationFrame: any;
declare const cancelAnimationFrame: any;

const Box = ({ bg, w = 200, h = 100 }: { bg: string; w?: number; h?: number }) => (
  <div style={{ width: w, height: h, background: bg }} />
);

/** Renders nothing until its "data" arrives, well after first paint. */
export const LateContent = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 300);
    return () => clearTimeout(t);
  }, []);
  return ready ? <Box bg="#00ff00" /> : null;
};

/** A small grey skeleton that grows to its real size once "data" arrives. */
export const Skeleton = () => {
  const [data, setData] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setData(true), 300);
    return () => clearTimeout(t);
  }, []);
  return data ? <Box bg="#00ff00" /> : <Box bg="#cccccc" w={50} h={20} />;
};

/**
 * Final size from the first paint, but red until a "fetch" the page can only
 * know about through `window.__storybunPending` resolves, then green. The
 * counter is released after the green render has committed.
 */
export const PendingCounter = () => {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    window.__storybunPending = (window.__storybunPending ?? 0) + 1;
    const t = setTimeout(() => setLoaded(true), 400);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (loaded) window.__storybunPending -= 1;
  }, [loaded]);
  return <Box bg={loaded ? "#00ff00" : "#ff0000"} />;
};

const LazyBox = lazy(
  () =>
    new Promise<{ default: () => React.JSX.Element }>((resolve) => {
      setTimeout(() => resolve({ default: () => <Box bg="#00ff00" /> }), 300);
    }),
);

/** The marker commits empty; the content commits when the lazy chunk lands. */
export const LazyMount = () => (
  <Suspense fallback={null}>
    <LazyBox />
  </Suspense>
);

/** Changes its text every frame, forever: the one story that must fail. */
export const NeverSettles = () => {
  const [n, setN] = useState(0);
  useEffect(() => {
    let id: number;
    const tick = () => {
      setN((x) => x + 1);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
  return <div style={{ width: 200, height: 100, background: "#00ff00" }}>{n}</div>;
};

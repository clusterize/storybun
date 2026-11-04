import { useEffect, useRef, useState } from "react";
import type React from "react";
import { readStored, writeStored } from "./storage.ts";

const WIDTH_KEY = "storybun:sidebar-width";
const MIN_WIDTH = 200;
const MAX_WIDTH = 640;

export function Layout({
  sidebar,
  children,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
}) {
  const [width, setWidth] = useState(() => readStored<number>(WIDTH_KEY, 300));
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => writeStored(WIDTH_KEY, width), [width]);

  const onPointerDown = (e: React.PointerEvent) => {
    start.current = { x: e.clientX, width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const next = start.current.width + e.clientX - start.current.x;
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
  };
  const onPointerUp = () => {
    start.current = null;
    setDragging(false);
  };

  return (
    <div className={`storybun-layout${dragging ? " resizing" : ""}`} style={{ ["--sb-sidebar-width" as string]: `${width}px` }}>
      <div className="storybun-sidebar">
        <div className="storybun-topbar">
          <svg className="storybun-logo-icon" width="20" height="20" viewBox="0 0 20 20" fill="none">
            <rect x="2" y="6" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
            <rect
              x="7"
              y="3"
              width="11"
              height="11"
              rx="2.5"
              fill="var(--sb-accent)"
              fillOpacity="0.3"
              stroke="var(--sb-accent)"
              strokeWidth="1.5"
            />
          </svg>
          <span className="storybun-logo-text">storybun</span>
        </div>
        {sidebar}
      </div>
      <div
        className="storybun-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setWidth(300)}
      />
      <div className="storybun-content">{children}</div>
    </div>
  );
}

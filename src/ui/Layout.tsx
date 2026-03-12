import type React from "react";

export function Layout({
  sidebar,
  children,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="storybun-layout">
      <div className="storybun-sidebar">
        <div className="storybun-topbar">
          <svg
            className="storybun-logo-icon"
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
          >
            <rect
              x="2"
              y="6"
              width="11"
              height="11"
              rx="2.5"
              stroke="currentColor"
              strokeWidth="1.5"
            />
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
      <div className="storybun-content">{children}</div>
    </div>
  );
}

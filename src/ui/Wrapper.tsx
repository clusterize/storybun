import type React from "react";

export function Wrapper({ children }: { children: React.ReactNode }) {
  return <div className="storybun-wrapper">{children}</div>;
}

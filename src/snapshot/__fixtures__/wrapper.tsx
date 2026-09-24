import React, { createContext, useContext } from "react";
import { ThemeContext } from "./wrapper-context.ts";
import "./wrapper.css";

// Children are forwarded through a context + outlet indirection rather than
// rendered inline, mirroring the shape of real router-style layout
// components (e.g. React Router's Outlet) -- the wrapper's own chrome sits
// around wherever the outlet happens to render, not necessarily adjacent to
// where `children` was received.
const OutletContext = createContext<React.ReactNode>(null);
function Outlet() {
  return useContext(OutletContext);
}

export function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ThemeContext.Provider value="provided">
      <OutletContext.Provider value={children}>
        <div
          className="storybun-fixture-wrapper"
          style={{ background: "rgb(255, 0, 0)", padding: 40, position: "relative" }}
        >
          <button type="button" style={{ position: "absolute", right: 0, top: 0 }}>
            chrome
          </button>
          <div data-toaster="true">toast</div>
          <Outlet />
        </div>
      </OutletContext.Provider>
    </ThemeContext.Provider>
  );
}

export default { title: "Fixtures/Grid" };

// A two-column grid whose root fills 100% of its available width. This is
// the other shape that `width: fit-content` on the marker collapsed (to a
// single 74px column) in an earlier attempt -- the fix must leave both
// columns laid out at their full production width.
export const TwoColumn = () => (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      width: "100%",
      boxSizing: "border-box",
    }}
  >
    <div style={{ background: "#0ea5e9", height: 50 }} />
    <div style={{ background: "#22c55e", height: 50 }} />
  </div>
);

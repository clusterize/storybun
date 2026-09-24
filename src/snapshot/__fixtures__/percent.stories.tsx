export default { title: "Fixtures/Percent" };

// A story whose root fills 100% of its available width. This is the shape
// that `width: fit-content` on the marker collapsed to 9px in an earlier
// attempt -- the fix must leave it laid out exactly as in production.
export const FullWidth = () => (
  <div
    style={{
      width: "100%",
      height: 50,
      background: "#0066ff",
      boxSizing: "border-box",
    }}
  />
);

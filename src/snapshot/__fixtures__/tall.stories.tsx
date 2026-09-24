const ROW_COUNT = 20;
const ROW_HEIGHT = 100;

export default { title: "Fixtures/Tall" };

export const Stack = () => (
  <div style={{ width: 400 }}>
    {Array.from({ length: ROW_COUNT }, (_, i) => (
      <div
        key={i}
        style={{
          height: ROW_HEIGHT,
          background: i % 2 === 0 ? "#22c55e" : "#0ea5e9",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "sans-serif",
          fontSize: 16,
          boxSizing: "border-box",
        }}
      >
        Row {i + 1}
      </div>
    ))}
  </div>
);

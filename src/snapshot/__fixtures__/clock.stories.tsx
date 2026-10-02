export default { title: "Fixtures/Clock" };

export const FROZEN_AT = "2026-07-30T12:00:00.000Z";

/** Green when the page clock reads exactly the configured instant, red otherwise. */
const Reading = () => {
  const frozen = new Date().toISOString() === FROZEN_AT;
  return <div style={{ width: 100, height: 60, background: frozen ? "#00ff00" : "#ff0000" }} />;
};

// Two exports of the same component, so one run captures two stories in
// sequence through the same context.
export const First = Reading;
export const Second = Reading;

import { Button } from "./Button.tsx";

export default { title: "Examples/Button" };

export const Primary = () => <Button variant="primary">Primary Button</Button>;

export const Secondary = () => (
  <Button variant="secondary">Secondary Button</Button>
);

export const Danger = () => <Button variant="danger">Danger Button</Button>;

export const Small = () => (
  <Button variant="primary" size="sm">
    Small
  </Button>
);

export const Large = () => (
  <Button variant="primary" size="lg">
    Large
  </Button>
);

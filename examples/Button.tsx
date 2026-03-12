import type React from "react";

interface ButtonProps {
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md" | "lg";
  children: React.ReactNode;
  onClick?: () => void;
}

const styles: Record<string, React.CSSProperties> = {
  base: {
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontWeight: 600,
    fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
    transition: "opacity 0.15s",
  },
  primary: { background: "#0066ff", color: "#fff" },
  secondary: { background: "#e0e0e0", color: "#1a1a1a" },
  danger: { background: "#ff3333", color: "#fff" },
  sm: { padding: "6px 12px", fontSize: 12 },
  md: { padding: "8px 16px", fontSize: 14 },
  lg: { padding: "12px 24px", fontSize: 16 },
};

export function Button({
  variant = "primary",
  size = "md",
  children,
  onClick,
}: ButtonProps) {
  return (
    <button
      style={{ ...styles.base, ...styles[variant], ...styles[size] }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

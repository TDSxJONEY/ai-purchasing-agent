import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Stamp({ children, tone = "ink" }: { children: ReactNode; tone?: "ink" | "good" | "bad" | "accent" }) {
  const color =
    tone === "good"
      ? "text-good border-good"
      : tone === "bad"
        ? "text-bad border-bad"
        : tone === "accent"
          ? "text-accent border-accent"
          : "text-ink border-rule";

  return (
    <span className={`inline-block border px-2 py-0.5 font-mono text-[11px] tracking-[0.14em] uppercase ${color}`}>
      {children}
    </span>
  );
}

export function LedgerButton({
  children,
  variant = "solid",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "ghost" }) {
  const styles =
    variant === "solid"
      ? "bg-ink text-surface hover:bg-accent"
      : "border border-rule text-ink hover:border-ink";

  return (
    <button
      {...props}
      className={`px-4 py-2 text-sm disabled:opacity-40 ${styles} ${props.className ?? ""}`}
    >
      {children}
    </button>
  );
}

export function Panel({
  title,
  kicker,
  children,
}: {
  title: string;
  kicker?: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-rule bg-panel p-5">
      {kicker ? (
        <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">{kicker}</p>
      ) : null}
      <h2 className="mt-1 text-xl">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

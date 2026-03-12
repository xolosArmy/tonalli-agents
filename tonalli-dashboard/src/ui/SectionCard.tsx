import type { PropsWithChildren } from "react";

type SectionCardProps = PropsWithChildren<{
  title: string;
  subtitle?: string;
}>;

export function SectionCard({
  title,
  subtitle,
  children
}: SectionCardProps) {
  return (
    <section className="card">
      <div className="section-heading">
        <div>
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

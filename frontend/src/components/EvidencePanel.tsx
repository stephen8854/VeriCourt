import type { ReactNode } from "react";

type Tone = "default" | "warning" | "procedural";

interface Props {
  title: string;
  children: ReactNode;
  tone?: Tone;
  headingLevel?: 2 | 3;
}

/** Bracketed editorial panel. All children are rendered as React text/elements, never as HTML. */
export function EvidencePanel({ title, children, tone = "default", headingLevel = 3 }: Props) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const toneClass = tone === "default" ? "" : ` evidence-panel--${tone}`;
  return (
    <section className={`evidence-panel${toneClass}`} aria-label={title}>
      <Heading>{title}</Heading>
      {children}
    </section>
  );
}

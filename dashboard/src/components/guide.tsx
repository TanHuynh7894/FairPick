import type { ReactNode } from 'react';

/** A page heading with its main actions beside it, and at most one line saying what the page is for. */
export function Intro({ id, title, tag, note, children }: { id: string; title: string; tag?: ReactNode; note?: string; children?: ReactNode }) {
  return (
    <section className="intro" aria-labelledby={`${id}-title`}>
      <div className="intro-head">
        <h2 id={`${id}-title`}>{title}</h2>
        {tag}
        {children && <div className="intro-actions">{children}</div>}
      </div>
      {note && <p className="intro-note">{note}</p>}
    </section>
  );
}

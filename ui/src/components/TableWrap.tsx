import type { ReactNode } from "react";

/** Horizontally scrollable table container, reachable by keyboard as a named region. */
export function TableWrap({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`table-wrap ${className}`.trim()} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

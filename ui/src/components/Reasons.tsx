import { useId, useState } from "react";

const LIMIT = 90;

/** Untrusted free text, rendered as text only and truncated with an expand control. */
export function Reason({ text, limit = LIMIT }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = text.length > limit;
  if (!long) return <span className="reason">{text}</span>;
  return (
    <span className="reason">
      <span id={id}>{open ? text : `${text.slice(0, limit).trimEnd()}…`}</span>
      <button type="button" className="btn-link" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {open ? "Less" : "More"}
      </button>
    </span>
  );
}

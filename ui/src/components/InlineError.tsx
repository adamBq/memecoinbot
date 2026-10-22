/** Inline, non-fatal error. Rendered where the data would have been. */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="inline-error" role="alert">
      <span className="icon" aria-hidden="true">!</span>
      <div>
        <strong>Could not load data.</strong> <span>{message}</span>
        {onRetry ? (
          <>
            {" "}
            <button type="button" className="btn-link" onClick={onRetry}>Retry</button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Small note shown above data that is still on screen after a failed refresh. */
export function StaleNote({ message }: { message: string }) {
  return (
    <p className="stale-note" role="status">
      Showing last good data; latest refresh failed: {message}
    </p>
  );
}

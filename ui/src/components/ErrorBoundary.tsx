import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  fallback: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Generic render-error boundary. Give it a `key` to reset automatically when context changes. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Render error", error, info);
  }

  reset = () => this.setState({ error: null });

  override render() {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}

/** True for a failed lazy chunk import (stale deploy, offline); the fix is a reload, not a re-render. */
export function isChunkLoadError(err: Error): boolean {
  return /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported/i.test(err.message);
}

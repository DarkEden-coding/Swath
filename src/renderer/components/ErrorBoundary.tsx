/**
 * Contains a render crash so it shows as text instead of a blank window.
 *
 * Used twice: around each pane, so one bad pane does not take the app with it, and around the
 * whole app, because anything thrown above the panes has no other net. Failures React cannot
 * catch at all — async callbacks, promise rejections — are handled by `lib/errorLog`.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../lib/errorLog";

interface Props {
  /** Named in the message, so it is obvious what died. */
  label: string;
  /**
   * True for the boundary that has nothing below it to keep working — its failure takes the whole
   * window, so it earns the overlay. A contained pane failure only goes to the log.
   */
  critical?: boolean;
  children: ReactNode;
}

interface State {
  error?: Error;
  stack?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(`${this.props.label} crashed`, error, this.props.critical);
    this.setState({ stack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="min-h-0 overflow-auto bg-swath-bg p-3 font-mono text-[11px] text-swath-muted">
        <div className="text-[#f87171]">
          {this.props.label} crashed: {error.message}
        </div>
        <button
          type="button"
          className="my-2 border border-swath-border px-2 py-0.5 hover:text-swath-text"
          onClick={() => this.setState({})}
        >
          retry
        </button>
        <pre className="whitespace-pre-wrap opacity-70">{stack}</pre>
      </div>
    );
  }
}

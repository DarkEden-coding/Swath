export type DeviceBrowser = {
  label: string;
  show(): Promise<void>;
  hide(): Promise<void>;
  close(): Promise<void>;
  setFocus(): Promise<void>;
};

// A remounted switcher must wait for its predecessor's native cleanup, not race a separate queue.
let nativeTransitions: Promise<void> = Promise.resolve();

/** Serializes native view operations; ownership checks prevent late events closing replacements. */
export class DeviceLifecycle<T extends DeviceBrowser> {
  readonly views = new Map<string, { browser: T; created: boolean }>();
  desired = "";
  mounted = true;
  private queue: Promise<void> = Promise.resolve();

  /** Inject native routing and focus operations so transitions can be exercised without a WebView. */
  constructor(
    private readonly route: (label: string | null) => Promise<void>,
    private readonly focusLocal: () => Promise<void>,
    private readonly onError: (error: unknown) => void = console.error,
  ) {}

  /** Keep later transitions usable after reporting a failed native operation. */
  private run(operation: () => Promise<void>): void {
    this.queue = nativeTransitions = nativeTransitions.then(operation).catch(this.onError);
  }

  /** Wait for all currently queued native changes. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Replace the desired device; queued work always consults the latest choice. */
  select(id: string): void {
    this.desired = id;
    this.reconcile();
  }

  /** Track a newly constructed view before its asynchronous creation completes. */
  add(id: string, browser: T): void {
    this.views.set(id, { browser, created: false });
  }

  /** Reconcile a live view or close a creation that completed after removal. */
  created(id: string, browser: T): void {
    const view = this.views.get(id);
    if (!this.mounted || view?.browser !== browser) {
      this.run(() => browser.close());
      return;
    }
    view.created = true;
    this.reconcile();
  }

  /** Drop only the failed view, never a replacement using the same connection ID. */
  error(id: string, browser: T): void {
    if (this.views.get(id)?.browser !== browser) return;
    this.views.delete(id);
    this.reconcile();
  }

  /** Remove ownership immediately and close an already created native view in order. */
  remove(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    if (view.created) this.run(() => view.browser.close());
    this.reconcile();
  }

  /** Release all views and reset native paste routing when the switcher leaves the tree. */
  unmount(): void {
    this.mounted = false;
    this.desired = "";
    for (const id of this.views.keys()) this.remove(id);
    this.reconcile();
  }

  /** Serialize routing, visibility and focus, checking ownership after native awaits. */
  reconcile(): void {
    this.run(async () => {
      const id = this.mounted ? this.desired : "";
      const target = this.views.get(id);
      try {
        if (!this.mounted) {
          await this.route(null);
          return;
        }
        // Do not expose either device's clipboard destination until visibility and focus agree.
        await this.route("device-unavailable");
        for (const [key, view] of this.views) {
          if (!this.mounted || this.desired !== id) return;
          if (key !== id && view.created) await view.browser.hide();
        }
        if (!this.mounted || this.desired !== id) return;
        if (id) {
          if (!target?.created || this.views.get(id) !== target) return;
          await target.browser.show();
          if (!this.mounted || this.desired !== id || this.views.get(id) !== target) return;
          await target.browser.setFocus();
        } else await this.focusLocal();
        if (this.mounted && this.desired === id && (!id || this.views.get(id) === target))
          await this.route(target?.browser.label ?? null);
      } catch (error) {
        // Visibility/focus is uncertain after failure. Block paste rather than target either device.
        await this.route("device-unavailable");
        throw error;
      }
    });
  }
}

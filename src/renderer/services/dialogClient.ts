import type { ConfirmDialogRequest } from "../../shared/types";

function confirmInApp(request: ConfirmDialogRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", request.message);
    Object.assign(backdrop.style, {
      position: "fixed",
      inset: "0",
      zIndex: "1000",
      display: "grid",
      placeItems: "center",
      background: "rgba(0, 0, 0, 0.55)",
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      width: "min(420px, calc(100vw - 32px))",
      border: "1px solid var(--swath-border, #30363d)",
      borderRadius: "10px",
      padding: "18px",
      color: "var(--swath-text, #f0f6fc)",
      background: "var(--swath-panel, #161b22)",
      boxShadow: "0 20px 60px rgba(0, 0, 0, 0.5)",
    });
    const title = document.createElement("h2");
    title.textContent = request.message;
    Object.assign(title.style, { margin: "0", fontSize: "15px", fontWeight: "600" });
    panel.appendChild(title);
    if (request.detail) {
      const detail = document.createElement("p");
      detail.textContent = request.detail;
      Object.assign(detail.style, {
        margin: "10px 0 0",
        color: "var(--swath-muted, #8b949e)",
        fontSize: "13px",
        lineHeight: "1.45",
        whiteSpace: "pre-wrap",
      });
      panel.appendChild(detail);
    }

    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
      marginTop: "18px",
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = request.cancelLabel ?? "Cancel";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = request.confirmLabel ?? "OK";
    for (const button of [cancel, confirm])
      Object.assign(button.style, {
        border: "1px solid var(--swath-border, #30363d)",
        borderRadius: "6px",
        padding: "7px 12px",
        color: "inherit",
        background: "var(--swath-bg, #0d1117)",
        cursor: "pointer",
      });
    confirm.style.background = "var(--swath-accent, #2f81f7)";
    actions.append(cancel, confirm);
    panel.appendChild(actions);
    backdrop.appendChild(panel);

    const finish = (value: boolean): void => {
      window.removeEventListener("keydown", onKeyDown);
      backdrop.remove();
      resolve(value);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") finish(false);
    };
    window.addEventListener("keydown", onKeyDown);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) finish(false);
    });
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    document.body.appendChild(backdrop);
    cancel.focus();
  });
}

export const dialogClient = {
  selectFolder: () => window.swath.dialog.selectFolder(),
  confirm: confirmInApp,
};

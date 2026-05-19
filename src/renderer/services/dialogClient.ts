import type { ConfirmDialogRequest } from "../../shared/types";

export const dialogClient = {
  selectFolder: () => window.swath.dialog.selectFolder(),
  confirm: (request: ConfirmDialogRequest) => window.swath.dialog.confirm(request),
};

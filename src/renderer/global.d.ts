import type { ReactElement } from "react";
import type { TpmApi } from "../main/preload";

declare global {
  namespace JSX {
    type Element = ReactElement;
  }

  interface Window {
    tpm: TpmApi;
  }
}

export {};

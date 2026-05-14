import type { ReactElement } from "react";
import type { SwathApi } from "../main/preload";

declare global {
  namespace JSX {
    type Element = ReactElement;
  }

  interface Window {
    swath: SwathApi;
  }
}

export {};

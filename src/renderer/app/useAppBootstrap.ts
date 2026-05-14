import { useEffect } from "react";
import { hydrateApp } from "./appActions";

export function useAppBootstrap(): void {
  useEffect(() => {
    void hydrateApp();
  }, []);
}

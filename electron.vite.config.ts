import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/main.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/preload.ts")
      }
    }
  },
  renderer: {
    root: ".",
    plugins: [react()],
    build: {
      cssCodeSplit: true,
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
            if (id.includes("node_modules/@xterm")) return "xterm";
            if (id.includes("node_modules/zustand")) return "zustand";
          }
        }
      }
    }
  }
});

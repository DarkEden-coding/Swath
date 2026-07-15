/// <reference types="vite/client" />

/**
 * Compatibility entry point for installing Swath in Vite/Tauri renderers.
 * Implementations live under platform/ so this module remains easy to audit.
 */
export { attachSwathAdapterIfMissing } from "./platform/installSwathAdapter";
export { attachSwathAdapterIfMissing as attachViteBrowserTpmIfMissing } from "./platform/installSwathAdapter";

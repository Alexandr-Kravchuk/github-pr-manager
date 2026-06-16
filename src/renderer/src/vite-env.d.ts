/// <reference types="vite/client" />

// The shape of `window.api` exposed by the preload bridge is declared here.
// Expanded in Phase 2 with the full invoke/event surface.
interface Window {
  api: import("../../shared/types").PrManagerApi;
}

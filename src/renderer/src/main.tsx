import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

async function bootstrap() {
  // Plain-browser dev (no Electron preload): install the mock bridge first.
  // The DEV guard makes the whole branch dead code in production builds.
  if (import.meta.env.DEV && !("api" in window)) {
    await import("./dev-mock");
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();

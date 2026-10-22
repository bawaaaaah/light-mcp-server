import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { reloadOnMissingChunk } from "./freshness";
import "./styles.css";

reloadOnMissingChunk();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

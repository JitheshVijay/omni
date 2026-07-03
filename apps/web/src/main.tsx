import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AppProviders } from "@/components/AppProviders";
import App from "@/App";
import { applyResolvedTheme, readStoredTheme, resolveTheme } from "@/components/theme";
import "@/globals.css";

// Apply the saved theme class before the first paint so dark-mode users
// don't get a white flash while React mounts.
applyResolvedTheme(resolveTheme(readStoredTheme()));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProviders>
        <App />
      </AppProviders>
    </BrowserRouter>
  </StrictMode>,
);

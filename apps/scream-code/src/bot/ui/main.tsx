import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./lib/i18n";
import { queryClient } from "./query-client";
import { router } from "./router";
import { installTheme } from "./lib/theme";
import "./styles/tokens.css";

installTheme();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("The workbench is missing its root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);

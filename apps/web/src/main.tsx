import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { TooltipProvider } from "@/components/ui/tooltip";
import { router } from "./router";
import { registerServiceWorker } from "./register-service-worker";
import "@/lib/theme";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  </StrictMode>,
);

registerServiceWorker();

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Popup, createDemoPopupAdapter } from "@lurkloot/popup-ui";
import "@lurkloot/popup-ui/fonts.css";
import "@lurkloot/popup-ui/styles.css";
import "./web.css";

declare const __LURKLOOT_REF__: string;

const demo = createDemoPopupAdapter({
  locale: "en",
  version: `upstream:${__LURKLOOT_REF__}`,
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <StrictMode>
    <main className="popup-stage">
      <Popup adapter={demo} />
    </main>
  </StrictMode>,
);

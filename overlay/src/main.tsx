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
    <div className="web-shell">
      <header className="web-header">
        <div>
          <div className="web-eyebrow">Lurkloot WebUI</div>
          <h1>Stock popup, web-hosted.</h1>
        </div>
        <div className="web-meta">
          <span>Mock adapter</span>
          <code>{__LURKLOOT_REF__}</code>
        </div>
      </header>

      <section className="web-note">
        This mock renders Lurkloot&apos;s upstream <code>@lurkloot/popup-ui</code> package directly.
        The farming backend is not connected yet.
      </section>

      <div className="popup-stage">
        <Popup adapter={demo} />
      </div>
    </div>
  </StrictMode>,
);

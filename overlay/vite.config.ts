import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const popupPath = fileURLToPath(new URL("../popup-ui/src/Popup.tsx", import.meta.url));
const popupSettingsPath = fileURLToPath(new URL("../popup-ui/src/settings.tsx", import.meta.url));
const popupRegistryPath = fileURLToPath(new URL("../popup-ui/src/settingsRegistry.tsx", import.meta.url));
const popupShellPath = fileURLToPath(new URL("../popup-ui/src/shell.tsx", import.meta.url));
const watchPriorityPath = fileURLToPath(new URL("../popup-ui/src/watchSourcePriority.tsx", import.meta.url));

function requireSource(source: string, needle: string, file: string): void {
  if (!source.includes(needle)) {
    throw new Error(
      `Lurkloot WebUI compatibility check failed: ${file} no longer contains ${JSON.stringify(needle)}. Review the upstream popup before publishing this build.`,
    );
  }
}

const supplementalFilter = `.filter((source) => {
  const capabilities = (globalThis as typeof globalThis & {
    __LURKLOOT_WEBUI_CAPABILITIES__?: { host?: { supplementalSources?: boolean } };
  }).__LURKLOOT_WEBUI_CAPABILITIES__;
  return capabilities?.host?.supplementalSources !== false
    || (source !== "nopixel" && source !== "fortnite");
})`;

const platformFilter = `.filter((id) => {
  const capabilities = (globalThis as typeof globalThis & {
    __LURKLOOT_WEBUI_CAPABILITIES__?: { transport?: { twitch?: boolean; kick?: boolean } };
  }).__LURKLOOT_WEBUI_CAPABILITIES__;
  return capabilities?.transport?.[id] !== false;
})`;

function webUiCompatibilityHooks(): Plugin {
  return {
    name: "lurkloot-webui-compatibility-hooks",
    enforce: "pre",

    buildStart() {
      const popup = readFileSync(popupPath, "utf8");
      requireSource(popup, "const sourceOrder = settings.platform[platform].watchSourcePriority;", "Popup.tsx");

      const settings = readFileSync(popupSettingsPath, "utf8");
      requireSource(settings, "<React.Fragment key={entry.id}>{entry.render()}</React.Fragment>", "settings.tsx");
      requireSource(settings, "<React.Fragment key={row.id}>{row.render()}</React.Fragment>", "settings.tsx");
      requireSource(settings, "const platformSections = (Object.keys(PLATFORMS) as Platform[])", "settings.tsx");

      const registry = readFileSync(popupRegistryPath, "utf8");
      for (const id of [
        "general.appearance.pauseOnManualWatch",
        "general.appearance.inPagePanel",
        "general.farmingTabs",
        "general.advanced.kickPageContextRecoverySuccesses",
        "twitch.advanced.channelPointsPushClaim",
      ]) {
        requireSource(registry, id, "settingsRegistry.tsx");
      }

      const shell = readFileSync(popupShellPath, "utf8");
      requireSource(shell, "const platformIds = Object.keys(PLATFORMS) as Platform[];", "shell.tsx");
      requireSource(shell, "data-view={item.view}", "shell.tsx");
      requireSource(shell, "data-platform-status={id}", "shell.tsx");
      requireSource(shell, "data-rail-group={labelKey}", "shell.tsx");

      const watchPriority = readFileSync(watchPriorityPath, "utf8");
      requireSource(watchPriority, "const order = normalizeWatchSourcePriority(platform, value);", "watchSourcePriority.tsx");
      requireSource(watchPriority, "void onChange([...DEFAULT_WATCH_SOURCE_PRIORITY[platform]]);", "watchSourcePriority.tsx");
      requireSource(watchPriority, "data-watch-source={source}", "watchSourcePriority.tsx");
    },

    transform(code, id) {
      const normalized = id.replaceAll("\\", "/");

      if (normalized.endsWith("/packages/popup-ui/src/settings.tsx")) {
        const entryFragment = "<React.Fragment key={entry.id}>{entry.render()}</React.Fragment>";
        const rowFragment = "<React.Fragment key={row.id}>{row.render()}</React.Fragment>";

        const entryCount = code.split(entryFragment).length - 1;
        const rowCount = code.split(rowFragment).length - 1;
        if (entryCount === 0 || rowCount === 0) {
          throw new Error("Lurkloot WebUI could not install semantic setting hooks into upstream settings.tsx");
        }

        return {
          code: code
            .replaceAll(entryFragment, '<div key={entry.id} data-setting-id={entry.id}>{entry.render()}</div>')
            .replaceAll(rowFragment, '<div key={row.id} data-setting-id={row.id}>{row.render()}</div>')
            .replace(
              "const platformSections = (Object.keys(PLATFORMS) as Platform[])",
              `const platformSections = (Object.keys(PLATFORMS) as Platform[])${platformFilter}`,
            ),
          map: null,
        };
      }

      if (normalized.endsWith("/packages/popup-ui/src/watchSourcePriority.tsx")) {
        return {
          code: code
            .replace(
              "const order = normalizeWatchSourcePriority(platform, value);",
              `const order = normalizeWatchSourcePriority(platform, value)${supplementalFilter};`,
            )
            .replace(
              "void onChange([...DEFAULT_WATCH_SOURCE_PRIORITY[platform]]);",
              `void onChange([...DEFAULT_WATCH_SOURCE_PRIORITY[platform]]${supplementalFilter});`,
            ),
          map: null,
        };
      }

      if (normalized.endsWith("/packages/popup-ui/src/shell.tsx")) {
        return {
          code: code.replace(
            "const platformIds = Object.keys(PLATFORMS) as Platform[];",
            `const platformIds = (Object.keys(PLATFORMS) as Platform[])${platformFilter};`,
          ),
          map: null,
        };
      }

      if (normalized.endsWith("/packages/popup-ui/src/Popup.tsx")) {
        return {
          code: code.replace(
            "const sourceOrder = settings.platform[platform].watchSourcePriority;",
            `const sourceOrder = settings.platform[platform].watchSourcePriority${supplementalFilter};`,
          ),
          map: null,
        };
      }

      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [webUiCompatibilityHooks(), react(), tailwindcss()],
  define: {
    __LURKLOOT_REF__: JSON.stringify(process.env.LURKLOOT_REF ?? "develop"),
  },
});

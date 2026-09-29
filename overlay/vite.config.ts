import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __LURKLOOT_REF__: JSON.stringify(process.env.LURKLOOT_REF ?? "develop"),
  },
});

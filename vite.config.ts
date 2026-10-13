import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port in dev and does not need the browser to open.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  base: "./",
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2021", outDir: "dist" },
});

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { cpSync, createReadStream, existsSync } from "node:fs";
import path from "node:path";

// Keep CJK maps, fallback fonts and decoders available offline in development and installers.
function pdfResources(): Plugin {
  let output = "";
  return {
    name: "xiaowang-pdf-resources",
    configResolved(config) { output = path.resolve(config.root, config.build.outDir); },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = request.url?.match(/^\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/([\w.-]+)(?:\?.*)?$/);
        if (!match) return next();
        const file = path.resolve("node_modules/pdfjs-dist", match[1]!, match[2]!);
        if (!existsSync(file)) return next();
        response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        createReadStream(file).pipe(response);
      });
    },
    closeBundle() {
      for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) cpSync(path.resolve("node_modules/pdfjs-dist", directory), path.join(output, "pdfjs", directory), { recursive: true });
    },
  };
}
export default defineConfig({
  root: "desktop/renderer",
  base: "./",
  plugins: [react(), pdfResources()],
  server: { port: 5173, strictPort: true },
  build: { outDir: "../dist/renderer", emptyOutDir: true },
});

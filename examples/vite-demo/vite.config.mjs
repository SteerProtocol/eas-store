import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import istanbul from "vite-plugin-istanbul";
import path from "node:path";

export default defineConfig({
  base: process.env.GITHUB_PAGES === "true" ? "/eas-store/" : "/",
  plugins: [
    tailwindcss(),
    istanbul({
      include: "src/**/*.{ts,tsx}",
      exclude: ["src/components/ui/**"],
      requireEnv: true,
      checkProd: true,
      forceBuildInstrument: true,
      cypress: false,
      generatorOpts: {
        comments: true
      }
    })
  ],
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "./src")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 4173
  },
  preview: {
    host: "127.0.0.1",
    port: 4173
  },
  build: {
    sourcemap: true
  }
});

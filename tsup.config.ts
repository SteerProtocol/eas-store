import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/testing.ts"],
  format: ["esm", "cjs"],
  sourcemap: true,
  target: "node20"
});

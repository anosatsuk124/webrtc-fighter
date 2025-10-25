import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	resolve: {
		alias: {
			// wasm-bindgen sometimes emits `import 'env'` — provide a stub module
			env: path.resolve(__dirname, "src/wasm_env_stub.ts"),
		},
	},
});

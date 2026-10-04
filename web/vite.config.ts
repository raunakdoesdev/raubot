import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
	base: "./",
	plugins: [tailwindcss(), svelte()],
	resolve: { alias: { $lib: page("./src/lib") } },
	build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: { index: page("index.html"), settings: page("settings.html"), secret: page("secret.html"), tree: page("tree.html") } } },
});

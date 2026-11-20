import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-netlify';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

// Telegram credentials are inlined into the bundle at build time. Accepted for a
// single-user deployment; mtcute warns the api hash cannot be revoked.
const env = loadEnv(process.env.NODE_ENV ?? 'development', '.', 'CHAFF_');

// `loadEnv`'s prefix filter excludes the Better Auth secrets, so the file is
// loaded into the real environment instead. Absolute path: cwd is the repo root.
try {
	process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));
} catch {
	// No `.env`: on CI and Netlify these arrive as real environment variables.
}

export default defineConfig({
	define: {
		'import.meta.env.CHAFF_API_ID': JSON.stringify(env.CHAFF_API_ID ?? ''),
		'import.meta.env.CHAFF_API_HASH': JSON.stringify(env.CHAFF_API_HASH ?? ''),
	},
	resolve: {
		// The CLI's pure core, shared without moving a file.
		alias: { '@core': fileURLToPath(new URL('../src/core', import.meta.url)) }
	},
	server: { fs: { allow: ['..'] } },
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Runes everywhere except libraries; removable in Svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: adapter({ edge: false })
		})
	]
});

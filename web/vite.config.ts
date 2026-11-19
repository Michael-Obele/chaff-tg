import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-netlify';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

// The Telegram app credentials live in `web/.env`, beside this file. They are
// inlined into the client bundle at build time (plan/web/issues/04) — accepted
// because the deployment is single-user, and mtcute's own docs warn the api hash
// cannot be revoked.
const env = loadEnv(process.env.NODE_ENV ?? 'development', '.', 'CHAFF_');


// Every other name in `.env` — the Better Auth secrets and DATABASE_URL — has to
// reach the SERVER process, not the bundle. `loadEnv`'s prefix filter above
// leaves them out, and values written into this config file do not survive into
// the SSR runtime; loading the file into the real environment does.
// The path is absolute because `process.cwd()` is the repo root, not `web/`.
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
		// The CLI's pure core, shared without moving a file (plan/web issues/02).
		alias: { '@core': fileURLToPath(new URL('../src/core', import.meta.url)) }
	},
	server: { fs: { allow: ['..'] } },
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
			// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
			// See https://svelte.dev/docs/kit/adapters for more information about adapters.
			adapter: adapter({ edge: false })
		})
	]
});

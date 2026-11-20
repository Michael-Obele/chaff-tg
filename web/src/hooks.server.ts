import { redirect } from '@sveltejs/kit';
import { auth } from './lib/server/auth';

/** The app's two pages. Everything else must stay reachable or the gate breaks `/login`. */
const GATED = new Set(['/', '/seam']);

/**
 * `/api/auth` is dispatched by prefix: `svelteKitHandler` compares origins and
 * answers with the SPA fallback instead of a 404-free mount when they differ.
 * The gate fails closed — a database error logs and redirects, never opens.
 */
export const handle = async ({ event, resolve }: { event: any; resolve: any }) => {
	if (event.url.pathname.startsWith('/api/auth')) return auth.handler(event.request);

	if (GATED.has(event.url.pathname)) {
		let session = null;
		try {
			session = await auth.api.getSession({ headers: event.request.headers });
		} catch (error) {
			console.error(
				`[auth] session check failed for ${event.url.pathname} — gate stays closed:`,
				error
			);
		}
		if (!session) redirect(303, '/login');
	}

	return resolve(event);
};

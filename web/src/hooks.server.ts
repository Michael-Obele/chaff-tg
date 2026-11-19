import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth } from './lib/server/auth';

// `/api/auth/*` belongs to Better Auth. `building: false` — this hook only runs
// in a Netlify function, and `$app/environment` does not resolve under
// svelte-check here.
export const handle = ({ event, resolve }: { event: any; resolve: any }) =>
	svelteKitHandler({ event, resolve, auth, building: false });

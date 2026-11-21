import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

/** `pg` treats a wrapping quote as part of the host and dials 127.0.0.1. */
function databaseUrl(): string {
	const raw = (process.env.DATABASE_URL ?? '').trim();
	if (
		(raw.startsWith('"') && raw.endsWith('"')) ||
		(raw.startsWith("'") && raw.endsWith("'"))
	) {
		return raw.slice(1, -1);
	}
	return raw;
}

/**
 * One account, seeded from env; sign-up is off.
 *
 * No `baseURL`. Better Auth derives it from the incoming request, and trusts
 * exactly that origin — so localhost, a preview URL and the live domain all work
 * with no env var to keep in sync. A credentialed POST from any other origin is
 * still refused, which is the CSRF check that matters.
 */
export const auth = betterAuth({
	secret: process.env.BETTER_AUTH_SECRET,
	database: new Pool({ connectionString: databaseUrl() }),
	emailAndPassword: {
		enabled: true,
		disableSignUp: true
	}
});

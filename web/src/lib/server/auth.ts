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
 * One account, seeded from env; sign-up is off. `trustedOrigins` is not optional:
 * it defaults to empty, and a correct `baseURL` alone still answers
 * `INVALID_ORIGIN` on every credentialed POST.
 */
export const auth = betterAuth({
	secret: process.env.BETTER_AUTH_SECRET,
	baseURL: process.env.BETTER_AUTH_URL,
	trustedOrigins: [process.env.BETTER_AUTH_URL].filter((url): url is string => Boolean(url)),
	database: new Pool({ connectionString: databaseUrl() }),
	emailAndPassword: {
		enabled: true,
		disableSignUp: true
	}
});

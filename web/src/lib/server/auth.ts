import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

/**
 * `DATABASE_URL` for `pg`: a string pasted with wrapping quotes makes pg treat
 * the quote as the host and dial 127.0.0.1.
 */
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
 * The single-user gate. Sign-up is off: the one account is seeded from env by
 * `scripts/seed-user.ts`. Telegram never touches this file — the browser talks
 * to Telegram directly.
 */
export const auth = betterAuth({
	secret: process.env.BETTER_AUTH_SECRET,
	baseURL: process.env.BETTER_AUTH_URL,
	database: new Pool({ connectionString: databaseUrl() }),
	emailAndPassword: {
		enabled: true,
		disableSignUp: true
	}
});

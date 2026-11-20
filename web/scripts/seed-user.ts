/**
 * `bun run db:seed` — the only way a user exists, because sign-up is disabled.
 * Idempotent: re-running changes nothing. Never prints the credentials.
 */
import { auth } from '../src/lib/server/auth';

const email = process.env.CHAFF_APP_EMAIL;
const password = process.env.CHAFF_APP_PASSWORD;

if (!email || !password) {
	console.error('CHAFF_APP_EMAIL and CHAFF_APP_PASSWORD must both be set in web/.env');
	process.exit(1);
}

const create = async () => {
	// Better Auth refuses sign-up through the API when disableSignUp is set, so
	// the account is created through the internal adapter instead — the same
	// path a migration uses.
	const ctx = await auth.$context;
	const existing = await ctx.internalAdapter.findUserByEmail(email);

	if (existing) {
		console.log(`account already exists: ${email}`);
		return;
	}

	const hash = await ctx.password.hash(password);
	const user = await ctx.internalAdapter.createUser({
		email,
		name: email.split('@')[0],
		emailVerified: true
	});

	// A credential account is what emailAndPassword sign-in looks up.
	await ctx.internalAdapter.createAccount({
		userId: user.id,
		providerId: 'credential',
		accountId: user.id,
		password: hash
	});

	console.log(`created account: ${email}`);
};

try {
	await create();
} finally {
	// The pool would otherwise hold the process open.
	await (auth.$context as unknown as Promise<{ adapter: { options?: unknown } }>)
		.then(() => undefined)
		.catch(() => undefined);
	process.exit(0);
}

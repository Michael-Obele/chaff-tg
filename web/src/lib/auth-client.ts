import { createAuthClient } from 'better-auth/svelte';
import { failure, info, step } from './log';

/**
 * The admin gate — the login before Telegram. It answers "may this person use
 * this deployment"; Telegram answers "whose chats are these". Two identities,
 * deliberately separate: `docs/telegram-setup.md`, section 3.
 */
export const authClient = createAuthClient();

export interface AdminUser {
	id: string;
	email: string;
}

/** The signed-in admin, or `null`. The one question both layers ask. */
export async function adminSession(): Promise<AdminUser | null> {
	try {
		const { data } = await authClient.getSession();
		const user = data?.user;
		if (!user) {
			info('auth', 'no admin session — the site gate is closed');
			return null;
		}
		info('auth', 'admin session present', { email: user.email });
		return { id: user.id, email: user.email };
	} catch (error) {
		// Fail closed: an unreachable auth function must never open the gate.
		failure('auth', 'session check failed — treating as signed out', error);
		return null;
	}
}

export type SignInOutcome = { ok: true } | { ok: false; error: string };

/** Exchange the seeded admin credentials for a session cookie. */
export async function adminSignIn(email: string, password: string): Promise<SignInOutcome> {
	step('auth', 'admin sign-in attempt', { email });
	try {
		const { error } = await authClient.signIn.email({ email, password });
		if (error) {
			// `disableSignUp` makes a wrong email and a wrong password the same answer on purpose.
			const text = error.message || error.statusText || `HTTP ${error.status}`;
			failure('auth', 'admin sign-in rejected', text);
			return { ok: false, error: text };
		}
		info('auth', 'admin signed in — opening the site gate');
		return { ok: true };
	} catch (error) {
		failure('auth', 'admin sign-in threw', error);
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

/**
 * Clears the cookie only. The Telegram session is IndexedDB; "sign out" calls both.
 */
export async function adminSignOut(): Promise<void> {
	step('auth', 'admin sign-out');
	try {
		await authClient.signOut();
		info('auth', 'session cookie cleared');
	} catch (error) {
		failure('auth', 'sign-out failed', error);
	}
}

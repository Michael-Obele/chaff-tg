import type { ChatRecord } from '@core/types';
import { API_HASH, API_ID, credentialsPresent } from './env';
import { failure, info, step, warn } from './log';
import { createWebApi, forgetSession, startSignIn, type TelegramApi } from './telegram';

export type Phase = 'setup' | 'signin' | 'loading' | 'ready' | 'leaving' | 'done';

/** One leave attempt, kept so the result screen can report honestly. */
export interface LeaveResult {
	chat: ChatRecord;
	ok: boolean;
	error?: string;
}

/**
 * `FLOOD_WAIT_21697` is the one worth spelling out: nothing was sent, and shown
 * raw it reads like a bug in this app.
 */
export function signInFailure(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const flood = /FLOOD_WAIT_(\d+)/.exec(text);
	if (flood) {
		const seconds = Number(flood[1]);
		const wait =
			seconds >= 3600
				? `${Math.round(seconds / 360) / 10} hours`
				: `${Math.max(1, Math.ceil(seconds / 60))} minutes`;
		return `Telegram is rate-limiting sign-in (${text}). Nothing was sent. Wait about ${wait}; retrying before then only repeats this error.`;
	}
	return text;
}

/** `$state` fields rather than a store, so reactivity is shared by assignment. */
export class Session {
	phase = $state<Phase>('setup');
	dialogs = $state.raw<ChatRecord[]>([]);
	loaded = $state(0);
	error = $state<string | null>(null);
	results = $state.raw<LeaveResult[]>([]);
	me = $state<{ name: string; username: string | null } | null>(null);

	prompt = $state<'phone' | 'code' | 'password'>('phone');
	promptValue = $state('');
	/** The form branches on this, not on `phase` — branching on `phase` deadlocked it. */
	awaiting = $state(false);
	private pending: ((value: string) => void) | null = null;
	private api: TelegramApi | null = null;

	readonly credentialsReady = credentialsPresent;

	/** Called by the form. Wakes whichever prompt is waiting. */
	answer(value: string) {
		const wasWaiting = this.pending !== null;
		info('session', `form answered the ${this.prompt} prompt`, { waiting: wasWaiting });
		this.pending?.(value);
		this.pending = null;
		this.promptValue = '';
		this.awaiting = false;
	}

	private ask(which: 'phone' | 'code' | 'password') {
		step('session', `prompt switched to ${which} (the form renders it)`);
		this.prompt = which;
		this.awaiting = true;
		return new Promise<string>((resolve) => (this.pending = resolve));
	}

	async signIn() {
		if (!this.credentialsReady) {
			warn('session', 'sign-in refused: this build has no CHAFF_API_ID / CHAFF_API_HASH');
			this.error = 'No Telegram credentials in this build. Fill web/.env and rebuild.';
			return;
		}
		step('session', 'signIn() from the setup screen', { apiId: API_ID, phase: this.phase });
		this.error = null;
		try {
			await startSignIn(API_ID, API_HASH, {
				phone: () => this.ask('phone'),
				code: () => this.ask('code'),
				password: () => this.ask('password'),
				onCodeSent: () => void (this.prompt = 'code'),
				onInvalid: (which) => void (this.error = `Wrong ${which}, try again.`)
			})();
			info('session', 'sign-in resolved — loading dialogs');
			this.phase = 'loading';
			await this.load();
		} catch (e) {
			failure('session', 'sign-in failed', e);
			this.error = signInFailure(e);
			this.phase = 'signin';
		}
	}

	async load() {
		this.api ??= createWebApi(API_ID, API_HASH);
		this.loaded = 0;
		step('session', 'reading dialogs');
		try {
			this.dialogs = await this.api.dialogs((n) => (this.loaded = n));
			info('session', `dialog list ready: ${this.dialogs.length} chats`);
			this.me = await this.api.me();
			this.phase = 'ready';
		} catch (e) {
			failure('session', 'load failed', e);
			this.error = e instanceof Error ? e.message : String(e);
			this.phase = 'ready';
		}
	}

	/** Leave the confirmed chats one at a time, paced like the CLI. */
	async leave(chats: ChatRecord[], delayMs = 1200) {
		if (!this.api) {
			warn('session', 'leave() called before a client existed — ignored');
			return;
		}
		step('session', `leaving ${chats.length} chat(s)`, { delayMs });
		this.phase = 'leaving';
		this.results = [];
		const out: LeaveResult[] = [];

		for (const chat of chats) {
			const startedAt = performance.now();
			step('session', `→ ${chat.id} ${chat.title}`);
			try {
				await this.api.leave(chat.id);
				out.push({ chat, ok: true });
				info('session', `✓ ${chat.id} in ${Math.round(performance.now() - startedAt)}ms`);
			} catch (e) {
				out.push({ chat, ok: false, error: e instanceof Error ? e.message : String(e) });
				failure('session', `✗ ${chat.id} ${chat.title}`, e);
				// A flood wait means stop, not retry: the rest would fail too.
				if (String(e).includes('FLOOD')) {
					warn('session', 'flood wait — stopping the run here');
					break;
				}
			}
			this.results = [...out];
			if (out.length < chats.length) await new Promise((r) => setTimeout(r, delayMs));
		}

		const left = new Set(out.filter((r) => r.ok).map((r) => r.chat.id));
		this.dialogs = this.dialogs.filter((c) => !left.has(c.id));
		this.phase = 'done';
		info('session', 'leave run finished', { left: left.size, failed: out.length - left.size });
	}

	async signOut() {
		step('session', 'sign out: closing the client, then deleting the session');
		await this.api?.destroy();
		// The stored session IS the account, so forget it or the next visit skips login.
		await forgetSession();		this.api = null;
		this.dialogs = [];
		this.results = [];
		this.me = null;
		this.phase = 'setup';
		this.prompt = 'phone';
		info('session', 'signed out');
	}
}

export const session = new Session();

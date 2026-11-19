import type { ChatRecord } from '@core/types';
import { API_HASH, API_ID, credentialsPresent } from './env';
import { createWebApi, forgetSession, startSignIn, type TelegramApi } from './telegram';

export type Phase = 'setup' | 'signin' | 'loading' | 'ready' | 'leaving' | 'done';

/** One leave attempt, kept so the result screen can report honestly. */
export interface LeaveResult {
	chat: ChatRecord;
	ok: boolean;
	error?: string;
}

/**
 * The whole client-side session. A class with `$state` fields so reactivity is
 * shared by assignment rather than by a store.
 */
export class Session {
	phase = $state<Phase>('setup');
	dialogs = $state.raw<ChatRecord[]>([]);
	loaded = $state(0);
	error = $state<string | null>(null);
	results = $state.raw<LeaveResult[]>([]);
	me = $state<{ name: string; username: string | null } | null>(null);

	/** Sign-in step, driven by the form. */
	prompt = $state<'phone' | 'code' | 'password'>('phone');
	promptValue = $state('');
	/** True while a prompt is blocking login; the form branches on this. */
	awaiting = $state(false);
	private pending: ((value: string) => void) | null = null;
	private api: TelegramApi | null = null;

	readonly credentialsReady = credentialsPresent;

	/** Called by the form. Wakes whichever prompt is waiting. */
	answer(value: string) {
		this.pending?.(value);
		this.pending = null;
		this.promptValue = '';
		this.awaiting = false;
	}

	private ask(step: 'phone' | 'code' | 'password') {
		this.prompt = step;
		this.awaiting = true;
		return new Promise<string>((resolve) => (this.pending = resolve));
	}

	async signIn() {
		if (!this.credentialsReady) {
			this.error = 'No Telegram credentials in this build. Fill web/.env and rebuild.';
			return;
		}
		this.error = null;
		try {
			await startSignIn(API_ID, API_HASH, {
				phone: () => this.ask('phone'),
				code: () => this.ask('code'),
				password: () => this.ask('password'),
				onCodeSent: () => void (this.prompt = 'code'),
				onInvalid: (which) => void (this.error = `Wrong ${which}, try again.`)
			})();
			this.phase = 'loading';
			await this.load();
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
			this.phase = 'signin';
		}
	}

	async load() {
		this.api ??= createWebApi(API_ID, API_HASH);
		this.loaded = 0;
		try {
			this.dialogs = await this.api.dialogs((n) => (this.loaded = n));
			this.me = await this.api.me();
			this.phase = 'ready';
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
			this.phase = 'ready';
		}
	}

	/** Leave the confirmed chats one at a time, paced like the CLI. */
	async leave(chats: ChatRecord[], delayMs = 1200) {
		if (!this.api) return;
		this.phase = 'leaving';
		this.results = [];
		const out: LeaveResult[] = [];

		for (const chat of chats) {
			try {
				await this.api.leave(chat.id);
				out.push({ chat, ok: true });
			} catch (e) {
				out.push({ chat, ok: false, error: e instanceof Error ? e.message : String(e) });
				// A flood wait means stop, not retry: the rest would fail too.
				if (String(e).includes('FLOOD')) break;
			}
			this.results = [...out];
			if (out.length < chats.length) await new Promise((r) => setTimeout(r, delayMs));
		}

		const left = new Set(out.filter((r) => r.ok).map((r) => r.chat.id));
		this.dialogs = this.dialogs.filter((c) => !left.has(c.id));
		this.phase = 'done';
	}

	async signOut() {
		await this.api?.destroy();
		// The stored session IS the account, so forget it or the next visit skips login.
		await forgetSession();
		this.api = null;
		this.dialogs = [];
		this.results = [];
		this.me = null;
		this.phase = 'setup';
		this.prompt = 'phone';
	}
}

export const session = new Session();

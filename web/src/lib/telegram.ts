import type { ChatRecord, ChatType } from '@core/types';
import {
	attachClientLogs,
	diagnose,
	failure,
	hashHint,
	info,
	maskPhone,
	maskSecret,
	step,
	warn
} from './log';

/** The only file in `web/` that imports `@mtcute/web`. */
export interface TelegramApi {
	dialogs(onCount?: (n: number) => void): Promise<ChatRecord[]>;
	leave(chatId: number): Promise<void>;
	me(): Promise<{ id: number; name: string; username: string | null }>;
	destroy(): Promise<void>;
}

export interface SignInHooks {
	phone(): Promise<string>;
	code(): Promise<string>;
	password(): Promise<string>;
	onCodeSent?: () => void;
	onInvalid?: (which: 'code' | 'password') => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Session lives here; a stored one means no phone prompt. */
const STORAGE = 'chaff-web';

function toRecord(dialog: any): ChatRecord | null {
	const peer = dialog?.peer;
	if (peer?.type !== 'chat') return null;

	const chat = peer.chat ?? {};
	const type = chat.chatType as ChatType | undefined;
	if (!type) return null;

	const date = dialog.lastMessage?.date;
	return {
		id: peer.id,
		type,
		title: chat.displayName ?? peer.displayName ?? String(peer.id),
		username: chat.username ?? null,
		members: chat.membersCount ?? null,
		muted: dialog.isMuted ?? null,
		archived: dialog.isArchived ?? false,
		pinned: dialog.isPinned ?? false,
		unread: dialog.unreadCount ?? 0,
		manuallyUnread: dialog.isManuallyUnread ?? false,
		banned: chat.isBanned ?? false,
		unavailable: chat.isLikelyUnavailable ?? false,
		isScam: chat.isScam ?? false,
		isFake: chat.isFake ?? false,
		isVerified: chat.isVerified ?? false,
		lastMessageAt: date ? new Date(date).toISOString() : null
	};
}

/** One client per tab: lists dialogs, leaves chats. */
export function createWebApi(apiId: number, apiHash: string): TelegramApi {
	let client: Promise<any> | null = null;

	// Dynamic import: the wasm bundle is not fetched before sign-in.
	const get = () => {
		if (!client) {
			step('client', 'building the client', { apiId, apiHash: hashHint(apiHash), storage: STORAGE });
			client = import('@mtcute/web')
				.then(({ TelegramClient }) => {
					const created = new TelegramClient({ apiId, apiHash, storage: STORAGE });
					attachClientLogs(created, 'client');
					info('client', 'client built');
					return created;
				})
				.catch((error) => {
					// Keep the slot empty so a retry rebuilds instead of reusing a rejection.
					client = null;
					failure('client', 'import or construction', error);
					throw error;
				});
		}
		return client;
	};

	return {
		async dialogs(onCount) {
			const tg = await get();
			step('dialogs', 'iterDialogs({ archived: "keep" })');
			const out: ChatRecord[] = [];
			let seen = 0;
			try {
				// `archived: 'keep'` — without it archived chats never arrive.
				for await (const dialog of tg.iterDialogs({ archived: 'keep' })) {
					seen += 1;
					const record = toRecord(dialog);
					if (record) out.push(record);
					if (out.length % 100 === 0) onCount?.(out.length);
				}
			} catch (error) {
				failure('dialogs', `iteration stopped after ${seen} dialogs (${out.length} usable)`, error);
				throw error;
			}
			step('dialogs', 'iteration finished', {
				dialogs: seen,
				records: out.length,
				skipped: seen - out.length
			});
			return out;
		},
		async leave(chatId) {
			const tg = await get();
			step('leave', `leaveChat ${chatId} { clear: true }`);
			try {
				await tg.leaveChat(chatId, { clear: true });
				info('leave', `left ${chatId}`);
			} catch (error) {
				failure('leave', `leaveChat ${chatId}`, error);
				throw error;
			}
		},
		async me() {
			const tg = await get();
			step('me', 'getMe()');
			try {
				const user = await tg.getMe();
				const out = {
					id: Number(user.id),
					name: user.displayName ?? String(user.id),
					username: user.username ?? null
				};
				info('me', 'account read', { id: out.id, username: out.username });
				return out;
			} catch (error) {
				failure('me', 'getMe()', error);
				throw error;
			}
		},
		async destroy() {
			step('client', 'closing the client (stopUpdatesLoop, then destroy)');
			const tg = await client?.catch(() => null);
			// Quiet stop first; `destroy` alone logs "Session is reset".
			await tg?.stopUpdatesLoop?.();
			await tg?.destroy?.();
			client = null;
			info('client', 'client closed');
		}
	};
}

/** Show the ask and the answer; the phone is masked, the code and 2FA password are not logged. */
function tracedPrompt(name: 'phone' | 'code' | 'password', ask: () => Promise<string>) {
	return async (): Promise<string> => {
		step('signin', `${name}: waiting for the form`);
		const value = await ask();
		step('signin', `${name}: answered`, {
			value: name === 'phone' ? maskPhone(value) : maskSecret(value)
		});
		return value;
	};
}

/**
 * `start()` is the whole probe: it calls `getMe` first and only runs the hooks on
 * an unauthorized session. There is no `authorize()` in 0.32.8 — calling it
 * threw, and the bare `catch` could not tell that from "no session".
 */
export function startSignIn(apiId: number, apiHash: string, hooks: SignInHooks) {
	return async () => {
		step('signin', 'begin', { apiId, apiHash: hashHint(apiHash), verbose: 'see ?tgdebug' });
		diagnose();

		const { TelegramClient } = await import('@mtcute/web');
		step('signin', '@mtcute/web imported');
		const tg: any = new TelegramClient({ apiId, apiHash, storage: STORAGE });
		attachClientLogs(tg, 'signin');

		let self: any;
		step('signin', 'start(): reading the account first, prompting only if it fails');
		try {
			self = await tg.start({
				phone: tracedPrompt('phone', hooks.phone),
				code: tracedPrompt('code', hooks.code),
				password: tracedPrompt('password', hooks.password),
				codeSentCallback: () => {
					info('signin', 'Telegram accepted sendCode — waiting for the login code');
					hooks.onCodeSent?.();
				},
				invalidCodeCallback: (which: 'code' | 'password') => {
					warn('signin', `Telegram rejected the ${which}`);
					hooks.onInvalid?.(which);
				}
			});
		} catch (error) {
			// The line to read when no code ever arrives: sendCode's failure is named here.
			failure('signin', 'start() rejected — nothing was sent or nothing came back', error);
			throw error;
		}

		info('signin', 'authorized', {
			id: Number(self?.id),
			name: self?.displayName ?? null,
			username: self?.username ?? null
		});

		await tg.stopUpdatesLoop?.();
		await tg.destroy?.();
		info('signin', 'sign-in client closed');

		return { id: Number(self.id), name: self.displayName ?? String(self.id) };
	};
}

/** Real logout: the session database is what makes the account, so delete it. */
export async function forgetSession(): Promise<void> {
	if (typeof indexedDB === 'undefined') {
		warn('session', 'indexedDB is unavailable — nothing to forget');
		return;
	}
	step('session', `deleting IndexedDB database "${STORAGE}"`);
	await new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase(STORAGE);
		req.onsuccess = () => {
			info('session', 'session database deleted');
			resolve();
		};
		req.onerror = () => {
			failure('session', 'deleteDatabase', req.error);
			reject(req.error);
		};
		req.onblocked = () => {
			warn('session', 'deleteDatabase blocked by another tab holding the database');
			resolve();
		};
	});
}

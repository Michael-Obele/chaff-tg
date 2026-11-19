import type { ChatRecord, ChatType } from '@core/types';

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
		client ??= import('@mtcute/web').then(
			({ TelegramClient }) => new TelegramClient({ apiId, apiHash, storage: STORAGE })
		);
		return client;
	};

	return {
		async dialogs(onCount) {
			const tg = await get();
			const out: ChatRecord[] = [];
			// `archived: 'keep'` — without it archived chats never arrive.
			for await (const dialog of tg.iterDialogs({ archived: 'keep' })) {
				const record = toRecord(dialog);
				if (record) out.push(record);
				if (out.length % 100 === 0) onCount?.(out.length);
			}
			return out;
		},
		async leave(chatId) {
			const tg = await get();
			await tg.leaveChat(chatId, { clear: true });
		},
		async me() {
			const tg = await get();
			const user = await tg.getMe();
			return {
				id: Number(user.id),
				name: user.displayName ?? String(user.id),
				username: user.username ?? null
			};
		},
		async destroy() {
			const tg = await client?.catch(() => null);
			// Quiet stop first; `destroy` alone logs "Session is reset".
			await tg?.stopUpdatesLoop?.();
			await tg?.destroy?.();
			client = null;
		}
	};
}

/**
 * Sign in, reusing the stored session when there is one.
 *
 * `authorize()` throws on a missing or expired key, which is the only case that
 * runs the phone/code/2FA prompts.
 */
export function startSignIn(apiId: number, apiHash: string, hooks: SignInHooks) {
	return async () => {
		const { TelegramClient } = await import('@mtcute/web');
		const tg: any = new TelegramClient({ apiId, apiHash, storage: STORAGE });

		// `authorize()` hangs on a missing session instead of throwing, so it is
		// bounded: anything slower than this is a cold login, not a stored one.
		let self: any;
		try {
			self = await Promise.race([
				tg.authorize(),
				new Promise((_, reject) => setTimeout(() => reject(new Error('no-session')), 3000))
			]);
		} catch {
			self = await tg.start({
				phone: hooks.phone,
				code: hooks.code,
				password: hooks.password,
				codeSentCallback: hooks.onCodeSent,
				invalidCodeCallback: hooks.onInvalid
			});
		}

		await tg.stopUpdatesLoop?.();
		await tg.destroy?.();

		return { id: Number(self.id), name: self.displayName ?? String(self.id) };
	};
}

/** Whether a usable session is already stored. Bounded: a hang means "none". */
export async function hasStoredSession(apiId: number, apiHash: string): Promise<boolean> {
	try {
		const { TelegramClient } = await import('@mtcute/web');
		const tg: any = new TelegramClient({ apiId, apiHash, storage: STORAGE });
		await Promise.race([
			tg.authorize(),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
		]);
		await tg.destroy?.();
		return true;
	} catch {
		return false;
	}
}

/** Real logout: the session database is what makes the account, so delete it. */
export async function forgetSession(): Promise<void> {
	if (typeof indexedDB === 'undefined') return;
	await new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase(STORAGE);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
		req.onblocked = () => resolve();
	});
}

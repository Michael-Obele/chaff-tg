import type { ChatRecord, ChatType, Filters } from '@core/types';

/** A `Filters` with everything unset — the core exports no default. */
export function emptyFilters(): Filters {
	return {
		types: null,
		keyword: [],
		any: [],
		not: [],
		regex: null,
		ids: null,
		muted: null,
		archived: null,
		inactiveDays: null,
		members: null,
		scam: false,
		fake: false,
		banned: false,
		unavailable: false,
		unread: null,
		pinned: null,
		include: [],
		exclude: [],
		limit: null
	};
}

export interface FilterChoice {
	key: string;
	label: string;
	apply(f: Filters): void;
}

/** The filter controls the list offers; each writes into a fresh copy. */
export const FILTER_CHOICES: FilterChoice[] = [
	{ key: 'muted', label: 'Muted', apply: (f) => void (f.muted = true) },
	{ key: 'unmuted', label: 'Not muted', apply: (f) => void (f.muted = false) },
	{ key: 'archived', label: 'Archived', apply: (f) => void (f.archived = true) },
	{ key: 'pinned', label: 'Pinned', apply: (f) => void (f.pinned = true) },
	{ key: 'unread', label: 'Unread', apply: (f) => void (f.unread = true) },
	{ key: 'banned', label: 'Banned', apply: (f) => void (f.banned = true) },
	{ key: 'inactive', label: 'Inactive 1y', apply: (f) => void (f.inactiveDays = 365) },
	{ key: 'groups', label: 'Groups', apply: (f) => void (f.types = GROUP_TYPES) }
];

const GROUP_TYPES: ChatType[] = ['group', 'supergroup', 'gigagroup'];

/** Apply the chosen toggles plus the keyword box to a fresh filter set. */
export function buildFilters(active: string[], keyword: string, exclude: number[]): Filters {
	const f = emptyFilters();
	for (const choice of FILTER_CHOICES) {
		if (active.includes(choice.key)) choice.apply(f);
	}
	const word = keyword.trim();
	if (word) f.keyword = [word];
	f.exclude = exclude;
	return f;
}

/** Users and bots have no dialog to leave; only chats do. */
export const LEAVEABLE: ReadonlySet<ChatType> = new Set([
	'group',
	'supergroup',
	'gigagroup',
	'channel',
	'monoforum',
	'community'
]);

export function canLeave(chat: ChatRecord): boolean {
	return LEAVEABLE.has(chat.type) && !chat.banned;
}

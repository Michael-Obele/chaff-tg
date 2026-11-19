<script lang="ts">
	import { filterRecords } from '@core/filters';
	import type { ChatRecord } from '@core/types';
	import { FILTER_CHOICES, buildFilters, canLeave } from '#lib/filters';

	let {
		dialogs,
		selection,
		onReview
	}: {
		dialogs: ChatRecord[];
		selection: Set<number>;
		onReview: () => void;
	} = $props();

	let keyword = $state('');
	let active = $state<string[]>([]);
	let onlyMatches = $state(true);

	const selected = $derived.by(() => active.slice());

	const rows = $derived.by(() => {
		if (!onlyMatches) return dialogs.map((chat) => ({ chat, ok: true, why: [] }));
		// `filterRecords` returns every row with an `ok` flag; accept on `ok`.
		return filterRecords(
			dialogs,
			buildFilters(selected, keyword, []),
			new Date()
		);
	});

	const shown = $derived(rows.filter((r) => r.ok));
	const leaveable = $derived(shown.filter((r) => canLeave(r.chat)));

	function toggleFilter(key: string) {
		active = active.includes(key) ? active.filter((k) => k !== key) : [...active, key];
	}

	function toggleChat(id: number) {
		if (selection.has(id)) selection.delete(id);
		else selection.add(id);
		selection = new Set(selection);
	}

	function selectAllMatches() {
		selection = new Set(leaveable.map((r) => r.chat.id));
	}

	function clearSelection() {
		selection = new Set();
	}

	function when(iso: string | null): string {
		if (!iso) return 'never';
		const days = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
		if (days < 1) return 'today';
		if (days < 30) return `${days}d`;
		if (days < 365) return `${Math.round(days / 30)}mo`;
		return `${(days / 365).toFixed(1)}y`;
	}
</script>

<div class="flex flex-col gap-3">
	<div class="flex flex-wrap items-center gap-2">
		<input
			type="search"
			placeholder="Title or @username"
			bind:value={keyword}
			class="min-w-48 flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900"
		/>
		<label class="flex items-center gap-1.5 text-xs text-neutral-600">
			<input type="checkbox" bind:checked={onlyMatches} />
			matched only
		</label>
	</div>

	<div class="flex flex-wrap gap-1.5">
		{#each FILTER_CHOICES as choice (choice.key)}
			<button
				type="button"
				class="rounded-full border px-2.5 py-1 text-xs transition-colors {active.includes(choice.key)
					? 'border-neutral-900 bg-neutral-900 text-white'
					: 'border-neutral-300 text-neutral-700 hover:border-neutral-500'}"
				onclick={() => toggleFilter(choice.key)}
			>
				{choice.label}
			</button>
		{/each}
	</div>

	<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-600">
		<span>
			{shown.length} of {dialogs.length} chats · {selection.size} selected
		</span>
		<span class="flex gap-3">
			<button type="button" class="hover:underline" onclick={selectAllMatches}>
				select {leaveable.length}
			</button>
			{#if selection.size}
				<button type="button" class="hover:underline" onclick={clearSelection}>clear</button>
			{/if}
		</span>
	</div>

	<div class="max-h-[60vh] overflow-y-auto rounded-md border border-neutral-200">
		<table class="w-full text-left text-sm">
			<thead class="sticky top-0 bg-neutral-50 text-xs text-neutral-500">
				<tr>
					<th class="w-8 p-2"></th>
					<th class="p-2 font-medium">Chat</th>
					<th class="p-2 font-medium">Type</th>
					<th class="p-2 text-right font-medium">Members</th>
					<th class="p-2 text-right font-medium">Last</th>
					<th class="p-2 font-medium">Why</th>
				</tr>
			</thead>
			<tbody>
				{#each shown as row (row.chat.id)}
					{@const chat = row.chat}
					<tr class="border-t border-neutral-100 hover:bg-neutral-50">
						<td class="p-2 align-top">
							<input
								type="checkbox"
								aria-label="Select {chat.title}"
								checked={selection.has(chat.id)}
								disabled={!canLeave(chat)}
								onchange={() => toggleChat(chat.id)}
							/>
						</td>
						<td class="p-2 align-top">
							<div class="font-medium">{chat.title}</div>
							{#if chat.username}
								<div class="text-xs text-neutral-500">@{chat.username}</div>
							{/if}
						</td>
						<td class="p-2 align-top text-xs text-neutral-600">{chat.type}</td>
						<td class="p-2 align-top text-right text-xs tabular-nums">
							{chat.members?.toLocaleString() ?? '—'}
						</td>
						<td class="p-2 align-top text-right text-xs tabular-nums">{when(chat.lastMessageAt)}</td>
						<td class="p-2 align-top">
							<div class="flex flex-wrap gap-1">
								{#each row.why as reason (reason)}
									<span class="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600">
										{reason}
									</span>
								{/each}
							</div>
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="6" class="p-8 text-center text-sm text-neutral-500">
							Nothing matches these filters.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if selection.size}
		<button
			class="self-start rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
			onclick={onReview}
		>
			Review {selection.size} before leaving
		</button>
	{/if}
</div>

<script lang="ts">
	import type { ChatRecord } from '@core/types';

	let {
		chats,
		onBack,
		onLeave
	}: {
		chats: ChatRecord[];
		onBack: () => void;
		onLeave: () => void;
	} = $props();

	let confirmWord = $state('');
	const ARMED = 'leave';
	const armed = $derived(confirmWord.trim().toLowerCase() === ARMED);
</script>

<div class="flex flex-col gap-4">
	<header>
		<h2 class="text-lg font-semibold">About to leave {chats.length} chats</h2>
		<p class="text-sm text-neutral-600">
			This is the last look. Read the list, then type <code class="font-mono">{ARMED}</code> to
			authorise it.
		</p>
	</header>

	<ul class="max-h-[50vh] overflow-y-auto rounded-md border border-neutral-200 text-sm">
		{#each chats as chat (chat.id)}
			<li class="flex items-center justify-between gap-3 border-b border-neutral-100 px-3 py-2 last:border-0">
				<span class="min-w-0">
					<span class="block truncate font-medium">{chat.title}</span>
					<span class="text-xs text-neutral-500">
						{chat.type}{chat.members ? ` · ${chat.members.toLocaleString()} members` : ''}
					</span>
				</span>
				<span class="shrink-0 text-xs tabular-nums text-neutral-500">
					{chat.id}
				</span>
			</li>
		{/each}
	</ul>

	<div class="flex flex-col gap-2">
		<label class="text-sm font-medium" for="confirm">Type "{ARMED}"</label>
		<input
			id="confirm"
			bind:value={confirmWord}
			autocomplete="off"
			class="rounded-md border border-neutral-300 px-3 py-2 font-mono text-sm outline-none focus:border-neutral-900"
		/>
	</div>

	<div class="flex gap-3">
		<button
			class="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50"
			onclick={onBack}
		>
			Back
		</button>
		<button
			class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
			disabled={!armed}
			onclick={onLeave}
		>
			Leave {chats.length} chats
		</button>
	</div>
</div>

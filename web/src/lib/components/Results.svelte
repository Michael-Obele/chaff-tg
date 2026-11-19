<script lang="ts">
	import type { LeaveResult } from '#lib/session.svelte';

	let { results, onDone }: { results: LeaveResult[]; onDone: () => void } = $props();

	const left = $derived(results.filter((r) => r.ok).length);
	const failed = $derived(results.filter((r) => !r.ok));
</script>

<div class="flex flex-col gap-4">
	<header>
		<h2 class="text-lg font-semibold">
			Left {left} of {results.length}
		</h2>
		{#if failed.length}
			<p class="text-sm text-red-700">
				{failed.length} failed. The first error is usually the reason for the rest — a flood wait
				stops the run.
			</p>
		{:else}
			<p class="text-sm text-neutral-600">Everything in the plan was left.</p>
		{/if}
	</header>

	<ul class="max-h-[50vh] overflow-y-auto rounded-md border border-neutral-200 text-sm">
		{#each results as r (r.chat.id)}
			<li class="flex items-start justify-between gap-3 border-b border-neutral-100 px-3 py-2 last:border-0">
				<span class="min-w-0">
					<span class="block truncate font-medium">{r.chat.title}</span>
					{#if r.error}
						<span class="text-xs text-red-700">{r.error}</span>
					{/if}
				</span>
				<span class="shrink-0 text-xs {r.ok ? 'text-green-700' : 'text-red-700'}">
					{r.ok ? 'left' : 'failed'}
				</span>
			</li>
		{/each}
	</ul>

	<button
		class="self-start rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
		onclick={onDone}
	>
		Back to the list
	</button>
</div>

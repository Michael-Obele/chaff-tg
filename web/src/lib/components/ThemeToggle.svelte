<script lang="ts">
	import { applyTheme, storedTheme, watchSystemTheme, type Theme } from '#lib/theme';

	let theme = $state<Theme>(storedTheme());

	const order: Theme[] = ['light', 'dark', 'system'];
	const label = $derived({ light: 'Light', dark: 'Dark', system: 'System' }[theme]);

	function cycle() {
		theme = order[(order.indexOf(theme) + 1) % order.length];
		applyTheme(theme);
	}

	$effect(() => watchSystemTheme());
</script>

<button
	onclick={cycle}
	title="Theme: {label}"
	class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
>
	{label}
</button>

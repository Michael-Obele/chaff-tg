<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { Toaster } from 'svelte-sonner';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
<Toaster richColors closeButton />

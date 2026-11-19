<script lang="ts">
	import { match } from '@core/filters';
	import { credentialsPresent } from '#lib/env';

	// Probe: proves the @core alias and build-time creds reach the browser bundle.
	const seamReady = typeof match === 'function';
</script>

<main class="p-6">
	<p>core seam: {seamReady ? 'loaded' : 'missing'}</p>
	<p>credentials inlined: {credentialsPresent ? 'yes' : 'no'}</p>
</main>

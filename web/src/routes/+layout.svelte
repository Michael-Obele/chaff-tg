<script lang="ts">
  import "../app.css";
  import favicon from "#lib/assets/favicon.svg";
  import { installTrace } from "#lib/log";
  import { Toaster } from "svelte-sonner";
  import type { LayoutProps } from "./$types";

  // The layout outlives every route, so the trace is ready before any component runs.
  installTrace();

  let { children }: LayoutProps = $props();
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
<Toaster richColors closeButton />

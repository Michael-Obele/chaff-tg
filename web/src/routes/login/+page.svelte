<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { adminSession, adminSignIn } from "#lib/auth-client";
  import { info, step as trace } from "#lib/log";
  import ThemeToggle from "#lib/components/ThemeToggle.svelte";

  let email = $state("");
  let password = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);

  const canSubmit = $derived(email.trim().length > 0 && password.length > 0);

  onMount(async () => {
    // Already through the door: there is nothing to ask.
    if (await adminSession()) await goto("/", { replace: true });
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    busy = true;
    error = null;
    trace("login", "form submitted", { email: email.trim() });
    const result = await adminSignIn(email.trim(), password);
    busy = false;
    if (result.ok) {
      info("login", "redirecting to the app");
      await goto("/", { replace: true });
      return;
    }
    error = result.error;
    password = "";
  }
</script>

<svelte:head>
  <title>chaff — sign in</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 p-6">
  <header class="flex items-center justify-between">
    <h1 class="text-xl font-semibold tracking-tight">chaff</h1>
    <ThemeToggle />
  </header>

  <section class="max-w-md space-y-4">
    <h2 class="text-lg font-semibold">Sign in</h2>
    <p class="text-sm text-muted-foreground">
      This deployment has one account. It comes from <code>web/.env</code> and is created by
      <code>bun run db:seed</code> — there is no sign-up here.
    </p>

    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <label class="text-sm font-medium" for="email">Email</label>
        <input
          id="email"
          type="email"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          bind:value={email}
          class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
      </div>

      <div class="space-y-1.5">
        <label class="text-sm font-medium" for="password">Password</label>
        <input
          id="password"
          type="password"
          autocomplete="current-password"
          bind:value={password}
          class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
      </div>

      <button
        type="submit"
        disabled={!canSubmit || busy}
        class="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>

      {#if error}
        <p class="text-sm text-destructive" role="alert">{error}</p>
      {/if}
    </form>
  </section>
</main>

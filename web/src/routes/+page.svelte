<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { session } from "#lib/session.svelte";
  import { adminSession, adminSignOut } from "#lib/auth-client";
  import SignIn from "#lib/components/SignIn.svelte";
  import ChatList from "#lib/components/ChatList.svelte";
  import Review from "#lib/components/Review.svelte";
  import Results from "#lib/components/Results.svelte";
  import ThemeToggle from "#lib/components/ThemeToggle.svelte";

  let selection = $state<Set<number>>(new Set());
  let mode = $state<"list" | "review">("list");

  /**
   * Catches what the server redirect cannot: a cookie expired mid-visit, or a
   * client-side return to `/`. Nothing Telegram renders until this answers.
   */
  let gate = $state<"checking" | "open">("checking");

  onMount(async () => {
    if (!(await adminSession())) {
      await goto("/login", { replace: true });
      return;
    }
    gate = "open";
  });

  /** Both doors: the IndexedDB session is the account, the cookie is the gate. */
  async function signOutAll() {
    await session.signOut();
    await adminSignOut();
    gate = "checking";
    await goto("/login", { replace: true });
  }

  const chosen = $derived(session.dialogs.filter((c) => selection.has(c.id)));

  async function leaveNow() {
    await session.leave(chosen);
    selection = new Set();
    mode = "list";
  }

  function reset() {
    session.phase = "ready";
    mode = "list";
  }
</script>

<svelte:head>
  <title>chaff — leave the chaff behind</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 p-6">
  <header class="flex items-center justify-between">
    <h1 class="text-xl font-semibold tracking-tight">chaff</h1>
    <div class="flex items-center gap-3">
      {#if gate === "open"}
        <span class="text-xs text-muted-foreground">
          {#if session.me}
            {session.me.username ? `@${session.me.username}` : session.me.name}
            ·
          {/if}
          <button class="hover:text-foreground hover:underline" onclick={signOutAll}>
            sign out
          </button>
        </span>
      {/if}
      <ThemeToggle />
    </div>
  </header>

  {#if gate === "checking"}
    <p class="py-16 text-center text-sm text-muted-foreground">Checking your session…</p>
  {:else if session.phase === "setup" || session.phase === "signin"}
    <SignIn />
  {:else if session.phase === "loading"}
    <p class="py-16 text-center text-sm text-muted-foreground">
      Reading your dialogs… {session.loaded.toLocaleString()} so far
    </p>
  {:else if session.phase === "ready" && mode === "list"}
    <ChatList dialogs={session.dialogs} {selection} onReview={() => (mode = "review")} />
  {:else if session.phase === "ready" && mode === "review"}
    <Review chats={chosen} onBack={() => (mode = "list")} onLeave={leaveNow} />
  {:else if session.phase === "leaving"}
    <p class="py-16 text-center text-sm text-muted-foreground">
      Leaving… {session.results.length} of {chosen.length} done
    </p>
  {:else if session.phase === "done"}
    <Results results={session.results} onDone={reset} />
  {/if}

  {#if gate === "open" && session.error && session.phase === "ready"}
    <p class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
      {session.error}
    </p>
  {/if}
</main>

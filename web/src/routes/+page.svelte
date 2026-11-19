<script lang="ts">
  import { session } from "#lib/session.svelte";
  import SignIn from "#lib/components/SignIn.svelte";
  import ChatList from "#lib/components/ChatList.svelte";
  import Review from "#lib/components/Review.svelte";
  import Results from "#lib/components/Results.svelte";
  import ThemeToggle from "#lib/components/ThemeToggle.svelte";

  let selection = $state<Set<number>>(new Set());
  let mode = $state<"list" | "review">("list");

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
      {#if session.me}
        <span class="text-xs text-muted-foreground">
          {session.me.username ? `@${session.me.username}` : session.me.name}
          ·
          <button class="hover:text-foreground hover:underline" onclick={() => session.signOut()}>
            sign out
          </button>
        </span>
      {/if}
      <ThemeToggle />
    </div>
  </header>

  {#if session.phase === "setup" || session.phase === "signin"}
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

  {#if session.error && session.phase === "ready"}
    <p class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
      {session.error}
    </p>
  {/if}
</main>

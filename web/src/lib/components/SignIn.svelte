<script lang="ts">
  import { toast } from "svelte-sonner";
  import { session } from "#lib/session.svelte";
  import { PHONE } from "#lib/env";
  import { info, step as trace } from "#lib/log";

  let value = $state(PHONE);

  const step = $derived(session.prompt);
  const copy = $derived(
    {
      phone: {
        label: "Phone number",
        hint: "Include the country code. Telegram sends the login code here once.",
        placeholder: "+234…",
        type: "tel",
        action: "Send code",
      },
      code: {
        label: "Login code",
        hint: "Telegram just sent this to your app or SMS.",
        placeholder: "12345",
        type: "text",
        action: "Continue",
      },
      password: {
        label: "Two-step password",
        hint: "The cloud password for this account.",
        placeholder: "••••••••",
        type: "password",
        action: "Sign in",
      },
    }[step],
  );

  const canSubmit = $derived(value.trim().length > 0);

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    trace("form", `submit on the ${step} prompt`, { length: value.trim().length });
    session.answer(value.trim());
    value = "";
  }

  async function signIn() {
    info("form", "Sign in with Telegram clicked", {
      credentialsReady: session.credentialsReady,
    });
    const id = toast.loading("Connecting to Telegram…");
    await session.signIn();
    toast.dismiss(id);
    if (session.error) toast.error(session.error);
    else if (session.phase === "loading") toast.success("Signed in");
  }
</script>

{#if session.phase === "setup" && !session.awaiting}
  <section class="max-w-md space-y-4">
    <h2 class="text-lg font-semibold">Connect your account</h2>
    <p class="text-sm text-muted-foreground">
      Your session stays in this browser. Nothing is sent to a server.
    </p>
    <button
      class="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
      onclick={signIn}
      disabled={!session.credentialsReady}
    >
      Sign in with Telegram
    </button>
    {#if !session.credentialsReady}
      <p class="text-sm text-destructive">
        No Telegram credentials in this build. Fill <code>web/.env</code> and rebuild.
      </p>
    {/if}
  </section>
{:else}
  <section class="max-w-md">
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <label class="text-sm font-medium" for="prompt">{copy.label}</label>
        <input
          id="prompt"
          type={copy.type}
          inputmode={step === "phone" ? "tel" : undefined}
          autocomplete={step === "password" ? "current-password" : "one-time-code"}
          placeholder={copy.placeholder}
          bind:value
          class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
        <p class="text-xs text-muted-foreground">{copy.hint}</p>
      </div>
      <button
        type="submit"
        disabled={!canSubmit}
        class="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
      >
        {copy.action}
      </button>
      {#if session.error}
        <p class="text-sm text-destructive" role="alert">{session.error}</p>
      {/if}
    </form>
  </section>
{/if}

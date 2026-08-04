/**
 * Host capability port (L7 host ports) — signatures and a router, no host code.
 *
 * An agent tool call may need something only the host can do: read the open
 * Outlook item, insert text at the Word cursor, read the Excel selection. Those
 * implementations live in the surface; the SDK owns the vocabulary and the
 * routing so every surface answers a tool call the same way.
 *
 * **No Office.js, Word.js or Graph type enters the SDK.** A capability is
 * described structurally — an id, typed args, a typed result — which is what
 * keeps `./adapters` importable from Node, Lit and React Native.
 */

/** One thing a host can do, addressed by a stable id. */
export interface HostCapability<Args = unknown, Result = unknown> {
  /**
   * Stable identifier, matched against the tool name in an agent frame.
   * Namespaced by host — `outlook.readCurrentItem`, `word.insertText`.
   */
  readonly id: string;
  /**
   * Perform it. May reject; {@link routeToolCall} turns a rejection into a
   * failed {@link HostCapabilityResult} rather than letting it escape into the
   * stream loop.
   */
  run(args: Args): Promise<Result>;
}

/** Outcome of a routed tool call. A discriminated union, so neither side is guessed. */
export type HostCapabilityResult<Result = unknown> =
  | { readonly ok: true; readonly value: Result }
  | {
      readonly ok: false;
      readonly reason: "unknown-capability" | "failed";
      readonly message: string;
    };

/** What a surface registers its capabilities into, and what the router reads. */
export interface HostCapabilityRegistry {
  register(capability: HostCapability): void;
  get(id: string): HostCapability | undefined;
  has(id: string): boolean;
  /** Registered ids, for an allow-list or a capability advertisement. */
  ids(): readonly string[];
}

/**
 * An in-memory registry.
 *
 * Per-instance rather than process-wide, unlike the crypto and analytics ports:
 * capabilities are host-specific and a server process could legitimately hold
 * more than one host context. A module singleton would make that impossible to
 * express.
 *
 * Re-registering an id replaces it, which is what a hot-reloading task pane needs;
 * silently ignoring the second registration would look like a no-op bug.
 */
export function createHostCapabilityRegistry(
  initial: readonly HostCapability[] = [],
): HostCapabilityRegistry {
  const capabilities = new Map<string, HostCapability>();
  for (const capability of initial) capabilities.set(capability.id, capability);

  return {
    register: capability => {
      capabilities.set(capability.id, capability);
    },
    get: id => capabilities.get(id),
    has: id => capabilities.has(id),
    ids: () => [...capabilities.keys()],
  };
}

/**
 * Route a tool call to a capability and normalise the outcome.
 *
 * Never throws. A tool call arrives from a stream frame, and an exception here
 * would tear down the turn the same way an unguarded observer callback did —
 * an unknown tool is a normal condition (the agent may be newer than the host),
 * not an error.
 *
 * The message is deliberately short and host-authored; it is fed back to the
 * agent, so it must not carry anything the agent should not see.
 */
export async function routeToolCall<Result = unknown>(
  registry: HostCapabilityRegistry,
  toolId: string,
  args: unknown,
): Promise<HostCapabilityResult<Result>> {
  const capability = registry.get(toolId);
  if (!capability) {
    return {
      ok: false,
      reason: "unknown-capability",
      message: `No host capability registered for "${toolId}".`,
    };
  }

  try {
    const value = (await capability.run(args)) as Result;
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      reason: "failed",
      message: err instanceof Error ? err.message : "Host capability failed.",
    };
  }
}

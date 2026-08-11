import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncStorageAdapter } from "../adapters/storage.js";
import type { Theme } from "./theme-mode.js";
import { nextThemeMode } from "./theme-mode.js";
import { useTheme } from "./useTheme.js";

/**
 * PDEV-7000 Part A. The SDK used to ship two contradictory theme activations —
 * `applyTheme` wrote `data-theme` while this hook toggled `<html class="dark">`
 * — and a `@custom-variant dark` keyed on `.dark` that collided with blokkit's
 * identically-named variant keyed on `[data-theme]`.
 *
 * The load-bearing assertion in this file is that `system` reaches the DOM
 * **unresolved**: blokkit's variant resolves it with its own
 * `@media (prefers-color-scheme: dark)` branch, so a hook that helpfully wrote
 * `dark` instead would make that branch dead and dark mode would silently stop
 * following the OS.
 */

/** Control `matchMedia` so the "OS" can be flipped mid-test. */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => {
      listeners.delete(fn);
    },
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
  return {
    /** Simulate the OS switching colour scheme. */
    flip(next: boolean) {
      mql.matches = next;
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

const themeAttr = () => document.documentElement.dataset.theme;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  // Both attributes, or a test asserting the host attribute is ABSENT passes or
  // fails depending on which test ran before it.
  document.documentElement.removeAttribute("data-host-theme");
});
afterEach(() => vi.unstubAllGlobals());

describe("nextThemeMode", () => {
  it("cycles light → dark → system → light", () => {
    expect(nextThemeMode("light")).toBe("dark");
    expect(nextThemeMode("dark")).toBe("system");
    expect(nextThemeMode("system")).toBe("light");
  });
});

describe("useTheme", () => {
  it("defaults to system and writes it to data-theme unresolved", () => {
    stubMatchMedia(true);

    const { result } = renderHook(() => useTheme());

    const [theme, mode] = result.current;
    expect(mode).toBe("system");
    // Resolved for JS consumers…
    expect(theme).toBe("dark");
    // …but the DOM keeps the preference, so blokkit's media-query branch runs.
    expect(themeAttr()).toBe("system");
  });

  it("writes an explicit choice through to data-theme", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current[2]()); // system → light

    expect(result.current[1]).toBe("light");
    expect(themeAttr()).toBe("light");

    act(() => result.current[2]()); // light → dark

    expect(result.current[1]).toBe("dark");
    expect(themeAttr()).toBe("dark");
  });

  it("never sets a `dark` class — the class mechanism is gone", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    act(() => result.current[2]());
    act(() => result.current[2]()); // land on dark

    expect(result.current[1]).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("follows the OS while on system, without touching the DOM", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe("light");

    act(() => media.flip(true));

    // The reported effective theme moves…
    expect(result.current[0]).toBe("dark");
    // …and data-theme deliberately does NOT: the CSS media query owns this.
    expect(themeAttr()).toBe("system");
  });

  it("ignores the OS once a theme is chosen explicitly", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current[2]()); // → light
    act(() => media.flip(true));

    expect(result.current[0]).toBe("light");
    expect(themeAttr()).toBe("light");
  });

  it("persists an explicit choice and restores it on the next mount", () => {
    stubMatchMedia(true);
    const first = renderHook(() => useTheme());
    act(() => first.result.current[2]()); // → light
    expect(localStorage.getItem("bb-theme")).toBe("light");
    first.unmount();

    const second = renderHook(() => useTheme());

    expect(second.result.current[1]).toBe("light");
    expect(themeAttr()).toBe("light");
  });

  it("stores `system` as absence rather than a value", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current[2]()); // → light (persisted)
    expect(localStorage.getItem("bb-theme")).toBe("light");
    act(() => result.current[2]()); // → dark
    act(() => result.current[2]()); // → system

    expect(localStorage.getItem("bb-theme")).toBeNull();
    expect(themeAttr()).toBe("system");
  });

  it("keeps per-tool preferences separate", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme("bb-dashboard-theme"));

    act(() => result.current[2]());

    expect(localStorage.getItem("bb-dashboard-theme")).toBe("light");
    expect(localStorage.getItem("bb-theme")).toBeNull();
  });

  it("advances twice when cycled twice in one tick", () => {
    // The stale-closure bug a reviewer caught on #32: `cycleTheme` computed
    // `next` from a closed-over `mode`, so two calls batched into one tick both
    // read the same value and the second was a no-op — a double click advanced
    // one step. The functional updater reads the live previous value.
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current[1]).toBe("system");

    act(() => {
      result.current[2]();
      result.current[2]();
    });

    // system -> light -> dark, not system -> light.
    expect(result.current[1]).toBe("dark");
  });

  it("keeps systemDark current while an explicit mode is set", () => {
    // Why the OS listener fires unconditionally. Skipping it in explicit modes
    // (as the same review suggested) leaves a stale value: flip the OS, then
    // switch to system, and the hook would report the pre-flip theme.
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current[2]()); // -> light, so systemDark is now unused
    act(() => media.flip(true)); //   OS goes dark while we ignore it
    act(() => result.current[2]()); // -> dark
    act(() => result.current[2]()); // -> system

    expect(result.current[1]).toBe("system");
    // Correct only because the listener kept running through explicit modes.
    expect(result.current[0]).toBe("dark");
  });

  it("uses an injected SyncStorageAdapter instead of localStorage", () => {
    // Proves the port is load-bearing rather than decorative (PDEV-7724): a host
    // without Web Storage — Node, or React Native — supplies its own, and the
    // hook must never reach a global behind its back.
    stubMatchMedia(false);
    const backing = new Map<string, string>([["k", "dark"]]);
    const injected = {
      get: (key: string) => backing.get(key) ?? null,
      set: (key: string, value: string) => {
        backing.set(key, value);
      },
      remove: (key: string) => {
        backing.delete(key);
      },
    };

    const { result } = renderHook(() => useTheme("k", injected));

    // Read through the adapter on mount.
    expect(result.current[1]).toBe("dark");

    act(() => result.current[2]()); // dark -> system, stored as absence
    expect(backing.has("k")).toBe(false);

    act(() => result.current[2]()); // system -> light
    expect(backing.get("k")).toBe("light");
    // And nothing leaked to the real localStorage.
    expect(localStorage.getItem("k")).toBeNull();
  });

  it("detaches its OS listener on unmount", () => {
    const media = stubMatchMedia(false);
    const { unmount } = renderHook(() => useTheme());
    expect(media.listenerCount()).toBe(1);

    unmount();

    expect(media.listenerCount()).toBe(0);
  });
});

/** A `SyncStorageAdapter` that also records every write, in order. */
function recordingStorage(initial?: Record<string, string>) {
  const backing = new Map<string, string>(Object.entries(initial ?? {}));
  const writes: string[] = [];
  const adapter: SyncStorageAdapter = {
    get: key => backing.get(key) ?? null,
    set: (key, value) => {
      backing.set(key, value);
      writes.push(`set:${key}=${value}`);
    },
    remove: key => {
      backing.delete(key);
      writes.push(`remove:${key}`);
    },
  };
  return { adapter, backing, writes };
}

/**
 * PDEV-7369, problem 2. The hook returned `[theme, mode, cycleTheme]` and nothing
 * else, so a surface with three explicit controls (Light, Dark, System) could not
 * be built on it: `ms-word-addin` had exactly that trio and had to collapse it
 * into one cycling control to adopt the hook. `setMode` is appended as a FOURTH
 * tuple element so `const [theme, mode, cycle] = useTheme()` keeps compiling.
 */
describe("useTheme — setMode", () => {
  it("keeps the three-element destructure working", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    const [theme, mode, cycleTheme, setMode] = result.current;

    expect(theme).toBe("light");
    expect(mode).toBe("system");
    expect(typeof cycleTheme).toBe("function");
    expect(typeof setMode).toBe("function");
  });

  it("writes the chosen mode straight through to data-theme", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current[3]("dark"));

    expect(result.current[1]).toBe("dark");
    expect(result.current[0]).toBe("dark");
    expect(themeAttr()).toBe("dark");
  });

  it("reaches any mode in one call, without walking the cycle", () => {
    // The behaviour a cycling-only control cannot offer: system to dark directly.
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current[1]).toBe("system");

    act(() => result.current[3]("dark"));

    expect(result.current[1]).toBe("dark");
  });

  it("persists an explicit choice through the same path as cycleTheme", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current[3]("light"));
    expect(localStorage.getItem("bb-theme")).toBe("light");

    act(() => result.current[3]("dark"));
    expect(localStorage.getItem("bb-theme")).toBe("dark");
  });

  it("stores `system` as absence, exactly as cycling to it does", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current[3]("dark"));
    expect(localStorage.getItem("bb-theme")).toBe("dark");

    act(() => result.current[3]("system"));

    expect(localStorage.getItem("bb-theme")).toBeNull();
    // And `system` still reaches the DOM unresolved, so blokkit's media-query
    // branch keeps working.
    expect(themeAttr()).toBe("system");
  });

  it("restores a setMode choice on the next mount", () => {
    stubMatchMedia(true);
    const first = renderHook(() => useTheme());
    act(() => first.result.current[3]("light"));
    first.unmount();

    const second = renderHook(() => useTheme());

    expect(second.result.current[1]).toBe("light");
    expect(themeAttr()).toBe("light");
  });

  it("leaves cycleTheme continuing from wherever setMode landed", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current[3]("dark"));
    act(() => result.current[2]()); // dark -> system

    expect(result.current[1]).toBe("system");
  });

  it("keeps setMode and cycleTheme referentially stable across re-renders", () => {
    // A consumer wires these into memoised buttons. A new identity per render
    // would defeat that memoisation on every parent render.
    stubMatchMedia(false);
    const { result, rerender } = renderHook(() => useTheme());
    const [, , cycleFirst, setFirst] = result.current;

    rerender();
    rerender();

    expect(result.current[2]).toBe(cycleFirst);
    expect(result.current[3]).toBe(setFirst);
  });

  it("stays stable across a mode change too", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    const [, , cycleFirst, setFirst] = result.current;

    act(() => result.current[3]("dark"));

    expect(result.current[2]).toBe(cycleFirst);
    expect(result.current[3]).toBe(setFirst);
  });
});

/**
 * PDEV-7369, problem 3. `system` was resolved from `prefers-color-scheme` only, so
 * the returned `theme` reported the OS even when the surface had painted itself in
 * the host's theme. In an Office task pane Word carries its own theme setting, so a
 * consumer branching on `theme` to pick a light or dark asset picked the wrong one
 * for the background it was sitting on, and `ms-word-addin` had to re-resolve
 * `theme` in a wrapper. The host theme is an INPUT: the SDK never reads
 * `Office.context.officeTheme` itself (invariant A).
 */
describe("useTheme — host theme", () => {
  it("resolves `system` from the host theme, ignoring the media query", () => {
    stubMatchMedia(false); // OS says light
    const { result } = renderHook(() => useTheme({ hostTheme: "dark" }));

    expect(result.current[1]).toBe("system");
    expect(result.current[0]).toBe("dark");
  });

  it("falls back to the media query when no host theme is supplied", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme({}));

    expect(result.current[0]).toBe("dark");
  });

  it("treats a null host theme as absent", () => {
    // A surface passes `null` until it has read the host, e.g. before Office.onReady
    // settles. That must behave exactly like omitting the input.
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme({ hostTheme: null }));

    expect(result.current[0]).toBe("dark");
  });

  it("lets an explicit light beat a dark host theme", () => {
    stubMatchMedia(true); // OS dark, host dark, user says light
    const { result } = renderHook(() => useTheme({ hostTheme: "dark" }));

    act(() => result.current[3]("light"));

    expect(result.current[0]).toBe("light");
    expect(themeAttr()).toBe("light");
  });

  it("lets an explicit dark beat a light host theme", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme({ hostTheme: "light" }));

    act(() => result.current[3]("dark"));

    expect(result.current[0]).toBe("dark");
    expect(themeAttr()).toBe("dark");
  });

  it("follows the host across a change, and the OS again once it goes away", () => {
    const media = stubMatchMedia(false);
    const { result, rerender } = renderHook(
      (props: { hostTheme: Theme | null }) => useTheme({ hostTheme: props.hostTheme }),
      { initialProps: { hostTheme: "dark" as Theme | null } },
    );
    expect(result.current[0]).toBe("dark");

    // The user flips Word to light while the OS stays light.
    rerender({ hostTheme: "light" });
    expect(result.current[0]).toBe("light");

    // The host input goes away. The OS listener kept running throughout, so the
    // fallback is current rather than stale.
    act(() => media.flip(true));
    rerender({ hostTheme: null });
    expect(result.current[0]).toBe("dark");
  });

  it("exposes the host theme as its own attribute, leaving data-theme verbatim", () => {
    // CSS has no `@media (office-theme: dark)` and so does need a hook, but
    // resolving into `data-theme` to provide one would kill blokkit's media-query
    // branch (PDEV-7000). A second attribute gives CSS the host without touching
    // the contract, and lets a stylesheet express the whole precedence itself.
    stubMatchMedia(false); // OS light, host dark
    const { result } = renderHook(() => useTheme({ hostTheme: "dark" }));

    expect(themeAttr()).toBe("system");
    expect(document.documentElement.dataset.hostTheme).toBe("dark");
    expect(result.current[0]).toBe("dark");
  });

  it("removes the host attribute when the host stops reporting, handing CSS back to the OS", () => {
    stubMatchMedia(false);
    const { rerender } = renderHook(
      ({ hostTheme }: { hostTheme: Theme | null }) => useTheme({ hostTheme }),
      {
        initialProps: { hostTheme: "dark" as Theme | null },
      },
    );
    expect(document.documentElement.dataset.hostTheme).toBe("dark");

    // Removing it rather than writing a value is what re-arms the
    // `:not([data-host-theme])` branch. Writing "light" would pin the pane light
    // on a dark OS.
    rerender({ hostTheme: null });
    expect(document.documentElement.hasAttribute("data-host-theme")).toBe(false);
  });

  it("never writes the host attribute for a caller that does not pass one", () => {
    stubMatchMedia(true);
    renderHook(() => useTheme());

    // Byte-identical DOM to before this option existed.
    expect(document.documentElement.hasAttribute("data-host-theme")).toBe(false);
  });

  it("still writes `system` verbatim when the media query is the resolver", () => {
    // The load-bearing PDEV-7000 assertion, unchanged for every caller that does
    // not opt in: resolving `system` in JS there would make blokkit's
    // media-query branch dead and dark mode would stop following the OS.
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    expect(themeAttr()).toBe("system");
    expect(result.current[0]).toBe("dark");
  });

  it("keeps `system` persisted as absence while the host theme is in force", () => {
    // The host decides what the pane LOOKS like. It must not touch the stored
    // PREFERENCE, or "follow the host" would become an explicit choice the user
    // never made, and switching Word's theme would silently pin the add-in.
    stubMatchMedia(false);
    const { adapter, backing } = recordingStorage();
    const { result } = renderHook(() =>
      useTheme({ storageKey: "k", storage: adapter, hostTheme: "dark" }),
    );

    expect(result.current[0]).toBe("dark");
    expect(result.current[1]).toBe("system");
    expect(backing.has("k")).toBe(false);
  });
});

describe("useTheme — call forms", () => {
  it("still accepts the positional (storageKey, storage) form", () => {
    // Five live consumers call it this way. Backward compatibility is the reason
    // `hostTheme` was NOT added as a third positional.
    stubMatchMedia(false);
    const { adapter, backing } = recordingStorage({ tool: "dark" });

    const { result } = renderHook(() => useTheme("tool", adapter));

    expect(result.current[1]).toBe("dark");
    act(() => result.current[3]("light"));
    expect(backing.get("tool")).toBe("light");
    expect(localStorage.getItem("tool")).toBeNull();
  });

  it("accepts storageKey and storage through the options object", () => {
    stubMatchMedia(false);
    const { adapter, backing } = recordingStorage({ tool: "dark" });

    const { result } = renderHook(() => useTheme({ storageKey: "tool", storage: adapter }));

    expect(result.current[1]).toBe("dark");
    act(() => result.current[3]("light"));
    expect(backing.get("tool")).toBe("light");
  });

  it("does not re-persist on every render when called with an inline options object", () => {
    // The object form necessarily allocates a new object per render. If the hook
    // fed that wrapper into a dependency array, the persist effect would re-run
    // and re-write storage on every render.
    stubMatchMedia(false);
    const { adapter, writes } = recordingStorage();
    const { rerender } = renderHook(() => useTheme({ storageKey: "k", storage: adapter }));
    const afterMount = writes.length;

    rerender();
    rerender();
    rerender();

    expect(writes.length).toBe(afterMount);
  });

  it("registers exactly one OS listener regardless of call form", () => {
    const media = stubMatchMedia(false);
    const { rerender } = renderHook(() => useTheme({ hostTheme: "dark" }));

    rerender();
    rerender();

    expect(media.listenerCount()).toBe(1);
  });
});

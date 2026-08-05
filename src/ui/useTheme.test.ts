import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

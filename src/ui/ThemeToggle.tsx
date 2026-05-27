import type { Theme, ThemeMode } from "./useTheme.js";

export interface ThemeToggleProps {
  /** Effective (resolved) theme — drives login-variant colour logic. */
  theme: Theme;
  /** User's explicit preference — drives which icon is shown. */
  mode: ThemeMode;
  /** Called when the user clicks the toggle button. */
  onToggle: () => void;
  /**
   * Visual context.
   * - "header" (default): dark sticky header — neutral-700 bg, white text, w-9 h-9.
   * - "login": gradient entry screen — adapts to light/dark, w-8 h-8.
   */
  variant?: "header" | "login";
}

/**
 * 3-state theme toggle button.
 *
 * light → dark → auto → light → …
 *
 * Renders Sun / Moon / Monitor icons (SVG, no emoji).
 * Pair with `useTheme` from `@theblockbrain/bb-client-sdk/ui`.
 */
export function ThemeToggle({
  theme,
  mode,
  onToggle,
  variant = "header",
}: ThemeToggleProps) {
  const label =
    mode === "light"
      ? "Zu Dunkel-Modus wechseln"
      : mode === "dark"
        ? "System-Theme folgen"
        : "Zu Hell-Modus wechseln";

  const headerClass =
    "inline-flex items-center justify-center w-9 h-9 rounded-lg border border-neutral-500 hover:border-neutral-300 bg-neutral-700 hover:bg-neutral-600 text-white transition-all duration-150 shadow-sm";

  const loginDarkClass =
    "inline-flex items-center justify-center w-8 h-8 rounded-lg border border-stone-600 hover:border-stone-400 bg-white/10 hover:bg-white/20 text-stone-300 hover:text-white transition-all duration-150";

  const loginLightClass =
    "inline-flex items-center justify-center w-8 h-8 rounded-lg border border-stone-300 hover:border-stone-500 bg-white/70 hover:bg-white text-stone-500 hover:text-stone-800 transition-all duration-150";

  const buttonClass =
    variant === "login"
      ? theme === "dark"
        ? loginDarkClass
        : loginLightClass
      : headerClass;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className={buttonClass}
    >
      {mode === "light" ? (
        <MoonIcon />
      ) : mode === "dark" ? (
        <SunIcon />
      ) : (
        <MonitorIcon />
      )}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

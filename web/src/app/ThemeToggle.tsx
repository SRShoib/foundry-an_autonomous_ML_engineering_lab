import { Button } from "../components/ui/Button";
import { useTheme } from "./ThemeProvider";

function MoonIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" className="shrink-0" fill="currentColor">
      <path d="M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" className="shrink-0" fill="currentColor">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 .5v2M8 13.5v2M.5 8h2M13.5 8h2M2.7 2.7l1.4 1.4M11.9 11.9l1.4 1.4M2.7 13.3l1.4-1.4M11.9 4.1l1.4-1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** The label names the ACTION (what pressing it does), the icon shows the destination. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button variant="quiet" className="w-8 px-0" aria-label={`Switch to ${next} theme`} onClick={toggle}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

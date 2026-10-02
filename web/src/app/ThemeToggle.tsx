import { Moon, Sun } from "lucide-react";

import { Button } from "../components/ui/Button";
import { useTheme } from "./ThemeProvider";

/** The label names the ACTION (what pressing it does), the icon shows the destination. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button variant="quiet" className="w-8 px-0" aria-label={`Switch to ${next} theme`} onClick={toggle}>
      {theme === "dark" ? (
        <Sun aria-hidden="true" strokeWidth={2.25} className="size-4 shrink-0" />
      ) : (
        <Moon aria-hidden="true" strokeWidth={2.25} className="size-4 shrink-0" />
      )}
    </Button>
  );
}

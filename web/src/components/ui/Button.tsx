import { Slot } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` is the filled deep-gradient control (docs/design-plan.md §3.1, §12.5: "Start run",
   * "Approve"); `default` is a bordered panel-surface control; `quiet` is text until hovered, for
   * toolbar chrome. */
  variant?: "primary" | "default" | "quiet";
  /** Render the child element (a router Link, say) with the button's styling. */
  asChild?: boolean;
}

/** Buttons state the action and nothing else: "Open experiment", never "View experiment →"
 * (SPEC's avoid-list). The boundary is --line-control, which is held to 3:1 by the contrast test;
 * the decorative --line-strong would fail WCAG 1.4.11 on a control.
 *
 * M9h: the primary fill is the DEEP brand gradient (--accent → --accent-to), the only part dark
 * enough to carry white text at 4.5:1 — which is also why it never LIGHTENS on hover. Hover instead
 * adds the brand glow (--shadow-glow-brand) and the `sheen` utility's one-pass highlight, and the
 * hover state never moves the button (`no-hover-motion`, styles/designRules.ts). Press is a 0.98
 * scale at --dur-instant. One arbitrary transition-property list carries every colour/shadow/transform
 * change rather than several `transition-*` utilities, which would just override one another. */
export function Button({
  variant = "default",
  asChild = false,
  className,
  type,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      {...(asChild ? {} : { type: type ?? "button" })}
      className={cn(
        "inline-flex min-h-11 items-center frame:min-h-8 justify-center gap-2 rounded-control px-3 text-sm font-medium",
        "transition-[background-color,border-color,box-shadow,color,transform] duration-(--dur-quick) ease-out",
        "active:scale-[0.98] active:duration-(--dur-instant) disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
        variant === "primary" &&
          "sheen brand-fill-deep border border-transparent text-accent-contrast shadow-raised hover:shadow-glow-brand",
        variant === "default" &&
          "border border-line-control bg-surface-panel text-fg shadow-highlight hover:border-accent-hover hover:bg-surface-raised hover:shadow-hover",
        variant === "quiet" && "border border-transparent text-fg hover:bg-surface-raised",
        className,
      )}
      {...props}
    />
  );
}

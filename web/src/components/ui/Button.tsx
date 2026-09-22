import { Slot } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` is the one filled, --accent control per screen (§7 M9g interaction motion: "Start
   * run", "Approve"); `default` is a bordered control; `quiet` is text until hovered, for toolbar
   * chrome. Exactly one variant carries fill color — this is still one accent, not a rainbow of
   * button styles. */
  variant?: "primary" | "default" | "quiet";
  /** Render the child element (a router Link, say) with the button's styling. */
  asChild?: boolean;
}

/** Buttons state the action and nothing else: "Open experiment", never "View experiment →"
 * (SPEC's avoid-list). The boundary is --line-control, which is held to 3:1 by the contrast test;
 * the decorative --line-strong would fail WCAG 1.4.11 on a control. §7 M9g: press feedback is a
 * 0.98 scale at --dur-instant; hover/color transitions stay at --dur-quick, per the interaction
 * motion table — a single arbitrary transition-property list carries both durations via the
 * active: modifier rather than two separate `transition-*` utilities (which would just override
 * one another). */
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
          "border border-transparent bg-accent text-accent-contrast shadow-highlight hover:bg-accent-hover hover:shadow-raised",
        variant === "default" &&
          "border border-line-control bg-surface-panel text-fg shadow-highlight hover:bg-surface-raised hover:shadow-hover",
        variant === "quiet" && "border border-transparent text-fg hover:bg-surface-raised",
        className,
      )}
      {...props}
    />
  );
}

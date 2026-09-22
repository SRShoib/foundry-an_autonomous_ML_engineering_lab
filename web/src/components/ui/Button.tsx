import { Slot } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `default` is a bordered control; `quiet` is text until hovered, for toolbar chrome. */
  variant?: "default" | "quiet";
  /** Render the child element (a router Link, say) with the button's styling. */
  asChild?: boolean;
}

/** Buttons state the action and nothing else: "Open experiment", never "View experiment →"
 * (SPEC's avoid-list). The boundary is --line-control, which is held to 3:1 by the contrast test;
 * the decorative --line-strong would fail WCAG 1.4.11 on a control. */
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
        "inline-flex min-h-11 items-center frame:min-h-8 justify-center gap-2 rounded-control px-3 text-sm font-medium text-fg",
        "transition-colors duration-(--dur-quick) ease-out disabled:cursor-not-allowed disabled:opacity-50",
        variant === "default" &&
          "border border-line-control bg-surface-panel hover:bg-surface-raised",
        variant === "quiet" && "border border-transparent hover:bg-surface-raised",
        className,
      )}
      {...props}
    />
  );
}

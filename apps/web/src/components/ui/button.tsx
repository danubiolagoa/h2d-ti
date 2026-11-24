import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
}

export function buttonClassName(variant: NonNullable<ButtonProps["variant"]>, className?: string) {
  return cn(
    "inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
    variant === "primary"
      ? "bg-accent text-accent-fg shadow-card hover:brightness-110"
      : "text-text hover:bg-surface-2",
    className,
  );
}

export function Button({ variant = "ghost", className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={buttonClassName(variant, className)} {...props} />;
}

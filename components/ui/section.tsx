"use client";

import * as React from "react";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// Collapsible block built on <details>, so it keeps native keyboard and print behaviour.
function Section({
  title,
  aside,
  open,
  onToggle,
  children,
  className,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details
      open={open}
      onToggle={(e) => onToggle?.((e.currentTarget as HTMLDetailsElement).open)}
      className={cn("group rounded-md border bg-card", className)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md px-3 py-2 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-4 stroke-[1.5] text-muted-foreground transition-transform group-open:rotate-90" />
        <span>{title}</span>
        {aside && <span className="ml-auto flex items-center gap-2">{aside}</span>}
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  );
}

export { Section };

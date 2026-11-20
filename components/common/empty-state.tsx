import * as React from "react";
import type { LucideIcon } from "lucide-react";

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <Icon className="size-8 stroke-[1.5] text-muted-foreground" aria-hidden="true" />
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

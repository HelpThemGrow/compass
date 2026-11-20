import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  badge,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  icon: LucideIcon;
  badge?: React.ReactNode;
}) {
  return (
    <Card className="gap-0 p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <Icon className="size-4 stroke-[1.5]" aria-hidden="true" />
      </div>
      <div className="tabular mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {detail && <div className="mt-1 break-words text-xs text-muted-foreground">{detail}</div>}
      {badge && <div className="mt-2">{badge}</div>}
    </Card>
  );
}

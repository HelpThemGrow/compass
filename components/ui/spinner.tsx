import { Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";

function Spinner({ className }: { className?: string }) {
  return <Loader2Icon aria-hidden="true" className={cn("size-4 animate-spin stroke-[1.5]", className)} />;
}

export { Spinner };

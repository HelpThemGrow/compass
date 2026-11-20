import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const noticeVariants = cva("rounded-md border border-l-[3px] px-3 py-2 text-[13px]", {
  variants: {
    tone: {
      warning: "border-warning/30 border-l-warning bg-warning/10",
      destructive: "border-destructive/30 border-l-destructive bg-destructive/10",
      info: "border-primary/30 border-l-primary bg-primary/10",
    },
  },
  defaultVariants: { tone: "warning" },
});

function Notice({ className, tone, ...props }: React.ComponentProps<"div"> & VariantProps<typeof noticeVariants>) {
  return <div role={tone === "destructive" ? "alert" : undefined} className={cn(noticeVariants({ tone }), className)} {...props} />;
}

export { Notice };

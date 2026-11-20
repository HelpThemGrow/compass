"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useTheme } from "@/components/providers/theme-provider";

function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();
  return <Sonner theme={resolvedTheme} className="toaster group" {...props} />;
}

export { Toaster };

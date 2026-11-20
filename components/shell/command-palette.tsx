"use client";

import * as React from "react";

import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ALL_ITEMS, type TabId } from "@/components/shell/nav";

export function CommandPalette({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (tab: TabId) => void;
}) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Go to…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {ALL_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.tab}
                value={item.label}
                onSelect={() => {
                  onSelect(item.tab);
                  onOpenChange(false);
                }}
              >
                <Icon className="stroke-[1.5]" />
                {item.label}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

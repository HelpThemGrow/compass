"use client";

import * as React from "react";
import { LogOutIcon, PanelLeftOpenIcon, SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/common/theme-toggle";
import type { SessionUser } from "@/components/shell/nav";

function initials(user: SessionUser): string {
  const src = (user?.name || user?.email || "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function Topbar({
  collapsed,
  onExpand,
  onOpenPalette,
  user,
}: {
  collapsed: boolean;
  onExpand: () => void;
  onOpenPalette: () => void;
  user: SessionUser;
}) {
  const [mac, setMac] = React.useState(false);
  React.useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);

  // Same request the old sidebar button made.
  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      location.href = "/login";
    }
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-5">
      {collapsed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Expand sidebar" onClick={onExpand}>
              <PanelLeftOpenIcon className="stroke-[1.5]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Expand sidebar</TooltipContent>
        </Tooltip>
      )}
      <span className="text-sm font-semibold tracking-tight">Compass</span>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenPalette}
          className="hidden h-8 w-64 items-center gap-2 rounded-md border bg-card px-3 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 md:flex"
        >
          <SearchIcon className="size-4 stroke-[1.5]" />
          <span>Search…</span>
          <kbd className="ml-auto text-[11px]">{mac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account menu"
              className="flex size-9 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {initials(user)}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="truncate">{user?.name || user?.email || "Account"}</div>
              {user && <div className="text-xs font-normal text-muted-foreground">{user.role === "editor" ? "Editor" : "Viewer"}</div>}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>
              <LogOutIcon className="stroke-[1.5]" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

"use client";

import * as React from "react";
import { ChevronDownIcon, PanelLeftCloseIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NAV_GROUPS, type SessionUser, type TabId } from "@/components/shell/nav";

const GROUPS_KEY = "compass-nav-open-groups";

function initials(user: SessionUser): string {
  const src = (user?.name || user?.email || "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function Sidebar({
  collapsed,
  onToggle,
  onSelect,
  active,
  user,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (tab: TabId) => void;
  active: TabId;
  user: SessionUser;
}) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(GROUPS_KEY);
      if (raw) setOpen(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const isOpen = (id: string, hasActive: boolean) => hasActive || (open[id] ?? true);

  function toggleGroup(id: string, current: boolean) {
    const next = { ...open, [id]: !current };
    setOpen(next);
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-3">
        <div className="flex min-w-0 items-center rounded-md bg-logo-surface px-2.5 py-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/vibha-logo.png"
            alt="Vibha"
            className={cn("w-auto object-contain", collapsed ? "h-6 max-w-6 object-left object-cover" : "h-7")}
          />
        </div>
        {!collapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Collapse sidebar"
                onClick={onToggle}
                className="text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
              >
                <PanelLeftCloseIcon className="stroke-[1.5]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Collapse sidebar</TooltipContent>
          </Tooltip>
        )}
      </div>

      <nav
        aria-label="Main"
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4 [--scroll-thumb-hover:rgb(255_255_255/0.45)] [--scroll-thumb:rgb(255_255_255/0.25)]"
      >
        {NAV_GROUPS.map((group, gi) => {
          const hasActive = group.items.some((i) => i.tab === active);
          const expanded = isOpen(group.id, hasActive);
          return (
            <div key={group.id}>
              {collapsed ? (
                gi > 0 && <Separator className="my-3 bg-sidebar-border" />
              ) : (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(group.id, expanded)}
                  className="flex h-11 w-full items-center justify-between rounded-md px-3 text-[14px] font-medium outline-none hover:bg-sidebar-accent/40 focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50"
                >
                  {group.label}
                  <ChevronDownIcon className={cn("size-4 stroke-[1.5] transition-transform", !expanded && "-rotate-90")} />
                </button>
              )}
              {(collapsed || expanded) && (
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = item.tab === active;
                    const btn = (
                      <button
                        type="button"
                        data-tab={item.tab}
                        aria-current={isActive ? "page" : undefined}
                        aria-label={collapsed ? item.label : undefined}
                        onClick={() => onSelect(item.tab)}
                        className={cn(
                          "flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-[14px] text-sidebar-foreground outline-none hover:bg-sidebar-accent/70 focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50",
                          collapsed && "justify-center px-0",
                          isActive &&
                            "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-[inset_3px_0_0_#f9b620]"
                        )}
                      >
                        <Icon className="size-[18px] shrink-0 stroke-[1.5]" />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </button>
                    );
                    return (
                      <li key={item.tab}>
                        {collapsed ? (
                          <Tooltip>
                            <TooltipTrigger asChild>{btn}</TooltipTrigger>
                            <TooltipContent side="right">{item.label}</TooltipContent>
                          </Tooltip>
                        ) : (
                          btn
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>

      <div className={cn("flex shrink-0 items-center gap-3 border-t border-sidebar-border p-3", collapsed && "justify-center")}>
        <div
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-medium text-white"
        >
          {initials(user)}
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{user ? user.name || user.email : "Signing in…"}</div>
            <div className="text-xs opacity-70">{user?.role === "editor" ? "Editor" : user ? "Viewer" : ""}</div>
          </div>
        )}
      </div>
    </aside>
  );
}

"use client";

import * as React from "react";

import { api, type Evaluation, type RubricOption } from "@/lib/client/api";
import { AppProvider } from "@/components/providers/app-context";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { CommandPalette } from "@/components/shell/command-palette";
import type { SessionUser, TabId } from "@/components/shell/nav";
import { AskTab } from "@/components/tabs/ask-tab";
import { GenerateTab } from "@/components/tabs/generate-tab";
import { HistoryTab } from "@/components/tabs/history-tab";
import { LibraryTab } from "@/components/tabs/library-tab";
import { RubricsTab } from "@/components/tabs/rubrics-tab";
import { SystemTab } from "@/components/tabs/system-tab";
import { VerifyTab } from "@/components/tabs/verify-tab";

const COLLAPSE_KEY = "compass-sidebar-collapsed";

export function AppShell() {
  const [collapsed, setCollapsed] = React.useState(false);
  const [active, setActive] = React.useState<TabId>("verify");
  const [user, setUser] = React.useState<SessionUser>(null);
  const [rubrics, setRubrics] = React.useState<RubricOption[]>([]);
  const [evaluation, setEvaluation] = React.useState<Evaluation | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(COLLAPSE_KEY);
    } catch {
      /* ignore */
    }
    setCollapsed(stored !== null ? stored === "1" : window.innerWidth < 1100);
  }, []);

  // Same requests the old page made on load: who is signed in, and which rubrics exist.
  React.useEffect(() => {
    api<{ user: SessionUser }>("/api/auth/me")
      .then((d) => setUser(d.user))
      .catch(() => {
        /* api() has already sent the browser to the sign-in page */
      });
    api<{ rubrics?: RubricOption[] }>("/api/rubrics")
      .then((d) => setRubrics(d.rubrics || []))
      .catch(() => {
        /* surfaced on the System tab */
      });
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function setCollapsedPersist(next: boolean) {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  const ctx = React.useMemo(
    () => ({
      user,
      isEditor: user?.role === "editor",
      rubrics,
      showTab: setActive,
      openEvaluation: (e: Evaluation) => {
        setEvaluation(e);
        setActive("verify");
      },
    }),
    [user, rubrics]
  );

  // Every tab stays mounted (just hidden) so a running review, chat history or draft survives tab switches.
  const panel = (id: TabId, node: React.ReactNode) => (
    <section hidden={active !== id} aria-label={id} className="w-full">
      {node}
    </section>
  );

  return (
    <AppProvider value={ctx}>
      <div className="flex h-screen overflow-hidden bg-background">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsedPersist(!collapsed)} onSelect={setActive} active={active} user={user} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            collapsed={collapsed}
            onExpand={() => setCollapsedPersist(false)}
            onOpenPalette={() => setPaletteOpen(true)}
            user={user}
          />
          <main id="main" className="min-h-0 flex-1 overflow-auto p-4 2xl:p-6">
            {panel("verify", <VerifyTab result={evaluation} onResult={setEvaluation} />)}
            {panel("generate", <GenerateTab active={active === "generate"} />)}
            {panel("ask", <AskTab />)}
            {panel("library", <LibraryTab active={active === "library"} />)}
            {panel("rubrics", <RubricsTab active={active === "rubrics"} />)}
            {panel("history", <HistoryTab active={active === "history"} />)}
            {panel("system", <SystemTab active={active === "system"} />)}
          </main>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onSelect={setActive} />
      </div>
    </AppProvider>
  );
}

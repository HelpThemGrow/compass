"use client";

import * as React from "react";

import type { Evaluation, RubricOption } from "@/lib/client/api";
import type { SessionUser, TabId } from "@/components/shell/nav";

type AppContextValue = {
  user: SessionUser;
  isEditor: boolean;
  rubrics: RubricOption[];
  showTab: (tab: TabId) => void;
  /** Show a saved review on the Verify tab. */
  openEvaluation: (evaluation: Evaluation) => void;
};

const AppContext = React.createContext<AppContextValue | null>(null);

export const AppProvider = AppContext.Provider;

export function useApp() {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

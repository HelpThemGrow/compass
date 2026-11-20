import {
  BookOpenIcon,
  ClipboardCheckIcon,
  FileCheck2Icon,
  HistoryIcon,
  MessageCircleQuestionIcon,
  PenLineIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";

export type TabId = "verify" | "generate" | "ask" | "library" | "rubrics" | "history" | "system";

export type NavItem = { label: string; tab: TabId; icon: LucideIcon };
export type NavGroup = { id: string; label: string; items: NavItem[] };

// The tabs themselves (and who may see what) are unchanged; this only groups them for the sidebar.
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "work",
    label: "Work",
    items: [
      { label: "Verify a document", tab: "verify", icon: FileCheck2Icon },
      { label: "Generate a document", tab: "generate", icon: PenLineIcon },
      { label: "Ask the framework", tab: "ask", icon: MessageCircleQuestionIcon },
    ],
  },
  {
    id: "reference",
    label: "Reference",
    items: [
      { label: "Knowledge base", tab: "library", icon: BookOpenIcon },
      { label: "Rubrics", tab: "rubrics", icon: ClipboardCheckIcon },
    ],
  },
  {
    id: "admin",
    label: "Records",
    items: [
      { label: "History", tab: "history", icon: HistoryIcon },
      { label: "System", tab: "system", icon: SettingsIcon },
    ],
  },
];

export const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

export type SessionUser = { name?: string; email?: string; role?: string } | null;

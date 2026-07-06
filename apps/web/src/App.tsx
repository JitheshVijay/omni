// Route table. Every page is code-split via lazyWithReload (stale-chunk
// auto-recovery) and rendered inside the AppShell (sidebar + inset). The
// chat section nests under ChatLayout so the conversations column persists
// across thread switches.

import { Suspense } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { lazyWithReload } from "@/lib/lazy-with-reload";
import { AppShell } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/skeleton";

const ChatLayout = lazyWithReload(() => import("@/pages/ChatLayout"));
const ChatIndexPage = lazyWithReload(() => import("@/pages/ChatIndexPage"));
const ChatThreadPage = lazyWithReload(() => import("@/pages/ChatThreadPage"));
const HubsListPage = lazyWithReload(() => import("@/pages/HubsListPage"));
const HubDetailPage = lazyWithReload(() => import("@/pages/HubDetailPage"));
const DrivePage = lazyWithReload(() => import("@/pages/DrivePage"));
const AgentPage = lazyWithReload(() => import("@/pages/AgentPage"));
const AgentRunPage = lazyWithReload(() => import("@/pages/AgentRunPage"));
const ToolsPage = lazyWithReload(() => import("@/pages/ToolsPage"));
const ImageStudioPage = lazyWithReload(() => import("@/pages/ImageStudioPage"));
const DocsListPage = lazyWithReload(() => import("@/pages/DocsListPage"));
const DocEditorPage = lazyWithReload(() => import("@/pages/DocEditorPage"));
const SlidesPage = lazyWithReload(() => import("@/pages/SlidesPage"));
const SheetsPage = lazyWithReload(() => import("@/pages/SheetsPage"));
const SheetEditorPage = lazyWithReload(() => import("@/pages/SheetEditorPage"));
const PodcastStudioPage = lazyWithReload(() => import("@/pages/PodcastStudioPage"));
const WorkflowsPage = lazyWithReload(() => import("@/pages/WorkflowsPage"));
const WorkflowEditorPage = lazyWithReload(() => import("@/pages/WorkflowEditorPage"));
const WorkflowRunPage = lazyWithReload(() => import("@/pages/WorkflowRunPage"));
const DeckEditorPage = lazyWithReload(() => import("@/pages/DeckEditorPage"));
const LibraryPage = lazyWithReload(() => import("@/pages/LibraryPage"));
const SecretaryPage = lazyWithReload(() => import("@/pages/SecretaryPage"));
const SkillsPage = lazyWithReload(() => import("@/pages/SkillsPage"));
const AgentBasePage = lazyWithReload(() => import("@/pages/AgentBasePage"));
const SystemViewPage = lazyWithReload(() => import("@/pages/SystemViewPage"));
const SettingsPage = lazyWithReload(() => import("@/pages/SettingsPage"));

// Lightweight route-level loading state while a lazy chunk fetches.
function PageFallback() {
  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-10">
      <Skeleton className="mb-6 h-8 w-56" />
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-2/3" />
      </div>
    </div>
  );
}

// The shell mounts once for all routes; each page fills the inset.
function ShellLayout() {
  return (
    <AppShell>
      <Suspense fallback={<PageFallback />}>
        <Outlet />
      </Suspense>
    </AppShell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<ShellLayout />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatLayout />}>
          <Route index element={<ChatIndexPage />} />
          <Route path="new" element={<ChatIndexPage />} />
          <Route path=":threadId" element={<ChatThreadPage />} />
        </Route>
        <Route path="/hubs" element={<HubsListPage />} />
        <Route path="/hubs/:hubId" element={<HubDetailPage />} />
        <Route path="/drive" element={<DrivePage />} />
        <Route path="/agent" element={<AgentPage />} />
        <Route path="/agent/:id" element={<AgentRunPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/tools/images" element={<ImageStudioPage />} />
        <Route path="/tools/docs" element={<DocsListPage />} />
        <Route path="/tools/docs/new" element={<DocEditorPage />} />
        <Route path="/tools/docs/:artifactId" element={<DocEditorPage />} />
        <Route path="/tools/slides" element={<SlidesPage />} />
        <Route path="/tools/slides/:artifactId" element={<DeckEditorPage />} />
        <Route path="/tools/sheets" element={<SheetsPage />} />
        <Route path="/tools/sheets/:artifactId" element={<SheetEditorPage />} />
        <Route path="/tools/podcast" element={<PodcastStudioPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/:id" element={<WorkflowEditorPage />} />
        <Route path="/workflows/:id/runs/:runId" element={<WorkflowRunPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/secretary" element={<SecretaryPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/agentbase" element={<AgentBasePage />} />
        <Route path="/agentbase/:id" element={<SystemViewPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Routes>
  );
}

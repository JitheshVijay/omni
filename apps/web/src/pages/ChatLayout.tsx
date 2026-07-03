// Layout for /chat, /chat/new, /chat/:threadId — the persistent conversations
// column plus a slot for the active page. Owning the ThreadList here keeps it
// mounted across thread switches (URL changes from /chat/a → /chat/b don't
// unmount the sidebar, so no refetch flash).

import { Outlet } from "react-router-dom";
import { ThreadList } from "@/components/chat/ThreadList";

export default function ChatLayout() {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <ThreadList />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

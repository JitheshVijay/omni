// Promise-based confirmation dialog — the in-app replacement for native
// window.confirm(), so destructive actions match the rest of the UI.
// Adapted from Flo101's ConfirmDialog, rebuilt on the Radix Dialog primitive
// (which brings focus trap + escape + portal for free).
//
// Usage:
//   const confirm = useConfirm();
//   if (await confirm({ title: "Delete?", message: "…", danger: true })) { … }
//
// Mount <ConfirmProvider> once near the app root (AppProviders does).

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  /** Bold heading. Optional. */
  title?: string;
  /** Body copy (string or nodes). */
  message: ReactNode;
  /** Label for the confirm button (default "Confirm"). */
  confirmLabel?: string;
  /** Label for the cancel button (default "Cancel"). */
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Returns an async confirm(opts) => Promise<boolean>. Resolves true on
 *  confirm, false on cancel / backdrop / Escape. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setOpts(options);
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOpts(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!opts}
        onOpenChange={(open) => {
          // Radix fires onOpenChange(false) on Escape/backdrop — treat as cancel.
          if (!open) settle(false);
        }}
      >
        <DialogContent className="max-w-sm" hideClose>
          <DialogHeader>
            {/* Radix requires a DialogTitle for a11y — fall back to "Confirm". */}
            <DialogTitle>{opts?.title ?? "Confirm"}</DialogTitle>
            <DialogDescription asChild>
              <div className="text-sm leading-relaxed text-muted">{opts?.message}</div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => settle(false)}>
              {opts?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={opts?.danger ? "destructive" : "default"}
              autoFocus
              onClick={() => settle(true)}
            >
              {opts?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

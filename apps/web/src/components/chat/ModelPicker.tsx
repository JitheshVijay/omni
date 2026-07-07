// Model selector fed by GET /api/models (curated registry ∩ live OpenRouter
// availability). Grouped by provider, pricing hint on each row, unavailable
// models disabled. Controlled component: the parent decides what a change
// means (PATCH the thread, PATCH settings, or set a hub default).

import { useMemo } from "react";
import { useApi } from "@/lib/use-api";
import type { ModelInfo } from "@/lib/types";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { prettyModel } from "@/lib/utils";

// Radix Select forbids empty-string item values; this sentinel represents
// "no explicit model" for pickers that allow inheriting a default.
export const MODEL_DEFAULT_SENTINEL = "__default__";

export interface ModelPickerProps {
  value: string | null | undefined;
  onChange: (modelId: string | null) => void;
  disabled?: boolean;
  className?: string;
  /** Adds an "Use default" row that maps to null (hub override pickers). */
  allowDefault?: boolean;
  defaultLabel?: string;
  /** Compact trigger for the chat header. */
  compact?: boolean;
}

export function ModelPicker({
  value,
  onChange,
  disabled,
  className,
  allowDefault,
  defaultLabel = "Use default",
  compact,
}: ModelPickerProps) {
  const { data, isInitialLoading } = useApi<{ models: ModelInfo[] }>("/api/models");
  const models = useMemo(() => data?.models ?? [], [data]);

  const byProvider = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const list = groups.get(m.provider) ?? [];
      list.push(m);
      groups.set(m.provider, list);
    }
    return [...groups.entries()];
  }, [models]);

  const selectValue = value ?? (allowDefault ? MODEL_DEFAULT_SENTINEL : undefined);
  const selected = models.find((m) => m.id === value);

  return (
    <Select
      value={selectValue}
      onValueChange={(v) => onChange(v === MODEL_DEFAULT_SENTINEL ? null : v)}
      disabled={disabled || isInitialLoading}
    >
      <SelectTrigger
        className={cn(
          compact && "h-8 w-auto min-w-[150px] border-transparent bg-transparent px-2 text-xs font-medium text-muted shadow-none hover:bg-ink/5 hover:text-ink",
          className,
        )}
        aria-label="Model"
      >
        <SelectValue placeholder={isInitialLoading ? "Loading models…" : "Pick a model"}>
          {selected ? selected.label : value ? prettyModel(value) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-[280px]">
        {allowDefault && (
          <SelectGroup>
            <SelectItem value={MODEL_DEFAULT_SENTINEL}>
              <span className="text-muted">{defaultLabel}</span>
            </SelectItem>
          </SelectGroup>
        )}
        {byProvider.map(([provider, group]) => (
          <SelectGroup key={provider}>
            <SelectLabel>{provider}</SelectLabel>
            {group.map((m) => {
              const unavailable = m.available === false;
              return (
                <SelectItem key={m.id} value={m.id} disabled={unavailable}>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2">
                      <span className="truncate">{m.label}</span>
                      {unavailable && (
                        <span className="text-[10px] uppercase tracking-wide text-muted">
                          unavailable
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] text-muted">{m.pricingHint}</span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
        {models.length === 0 && !isInitialLoading && (
          <div className="px-3 py-2 text-sm text-muted">No models available.</div>
        )}
      </SelectContent>
    </Select>
  );
}

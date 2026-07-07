// "Save as Skill": the artifact/prompt → reusable Skill handoff (Genspark's
// "save as template"). Drops into a generator editor's toolbar as a small,
// unobtrusive button; opening it seeds a create-Skill dialog with the
// artifact's source prompt already filled in. Mirrors the New Skill create
// flow on SkillsPage (same fields, same createSkill() call), but pre-targeted
// at the format the user is currently working in.

import { useRef, useState } from "react";
import { BookmarkPlus, Check, Loader2 } from "lucide-react";
import {
  createSkill,
  SKILL_ROLES,
  SKILL_OUTPUTS,
  type SkillOutput,
  type SkillRole,
} from "@/lib/skills";
import { invalidateApiPrefix } from "@/lib/use-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** The formats an artifact editor can save from, a subset of SkillOutput. */
export type SaveSkillTarget = "doc" | "slides" | "sheet" | "image" | "chat";

const OUTPUT_LABEL: Record<SkillOutput, string> = {
  doc: "Docs",
  slides: "Slides",
  sheet: "Sheets",
  image: "Images",
  chat: "Chat",
  data: "Data",
};

export function SaveAsSkillButton({
  defaultName,
  defaultPrompt,
  target,
  defaultOutput,
  size = "sm",
  variant = "secondary",
  disabled = false,
}: {
  defaultName?: string;
  defaultPrompt: string;
  target: SaveSkillTarget;
  defaultOutput?: SkillOutput;
  size?: "sm" | "default";
  variant?: "secondary" | "ghost" | "default";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <>
      <Button
        size={size}
        variant={variant}
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label="Save as Skill"
      >
        {saved ? <Check className="text-emerald-500" /> : <BookmarkPlus />}
        {saved ? "Saved" : "Save as Skill"}
      </Button>

      <SaveSkillDialog
        open={open}
        onOpenChange={setOpen}
        defaultName={defaultName}
        defaultPrompt={defaultPrompt}
        target={target}
        defaultOutput={defaultOutput ?? (target as SkillOutput)}
        onSaved={() => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2500);
        }}
      />
    </>
  );
}

function SaveSkillDialog({
  open,
  onOpenChange,
  defaultName,
  defaultPrompt,
  target,
  defaultOutput,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultName?: string;
  defaultPrompt: string;
  target: SaveSkillTarget;
  defaultOutput: SkillOutput;
  onSaved: () => void;
}) {
  const [name, setName] = useState(defaultName ?? "");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState<SkillRole>("General");
  const [output, setOutput] = useState<SkillOutput>(defaultOutput);
  const [template, setTemplate] = useState(defaultPrompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form each time the dialog opens (render-phase state seeding,
  // the same pattern the image detail dialog uses) so it always reflects the
  // current artifact's prompt/title.
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current) {
    wasOpenRef.current = true;
    setName(defaultName ?? "");
    setDescription("");
    setRole("General");
    setOutput(defaultOutput);
    setTemplate(defaultPrompt);
    setError(null);
    setSaving(false);
  } else if (!open && wasOpenRef.current) {
    wasOpenRef.current = false;
  }

  async function submit() {
    if (!name.trim() || !template.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createSkill({
        name: name.trim(),
        description: description.trim() || undefined,
        role,
        output,
        target,
        prompt_template: template.trim(),
      });
      await invalidateApiPrefix("/api/skills");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that skill.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="max-h-[88vh] overflow-y-auto scrollbar-thin sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookmarkPlus className="size-4 text-accent" />
            Save as Skill
          </DialogTitle>
          <DialogDescription>
            Turn this into a reusable Skill. Use{" "}
            <code className="rounded bg-surface3 px-1 py-0.5 text-[11px] text-ink">
              {"{{input}}"}
            </code>{" "}
            in the template where the running text should go. Leave it out to
            reuse the prompt as-is.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. One-page project brief"
              maxLength={120}
              autoFocus
            />
          </Field>

          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line on what this skill does"
              maxLength={500}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Role">
              <Select value={role} onValueChange={(v) => setRole(v as SkillRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SKILL_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Output">
              <Select value={output} onValueChange={(v) => setOutput(v as SkillOutput)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SKILL_OUTPUTS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {OUTPUT_LABEL[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Prompt template">
            <Textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={"Write a one-page project brief for: {{input}}."}
              rows={7}
              maxLength={8000}
              className="font-mono text-xs"
            />
          </Field>

          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || !template.trim() || saving}>
            {saving ? <Loader2 className="animate-spin" /> : <BookmarkPlus />}
            {saving ? "Saving…" : "Save skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

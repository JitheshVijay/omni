// Zip a generated project's files into a downloadable archive. No external
// service — the user gets the full source to run or deploy anywhere.
import JSZip from "jszip";
import type { ProjectFile } from "./e2b.js";

export async function zipProject(files: ProjectFile[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const f of files) {
    // Normalize away any leading slash so paths are repo-relative.
    zip.file(f.path.replace(/^\/+/, ""), f.content);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** A filesystem-safe download name for a project. */
export function zipName(name: string): string {
  const slug = name.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `${slug || "omni-app"}.zip`;
}

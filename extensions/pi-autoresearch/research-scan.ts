/** Filesystem-only campaign discovery helpers shared by research gates. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as researchState from "./research-state.ts";

/** Lists campaign directory names; null means the root could not be inspected. */
export function listResearchCampaignIds(base: string): string[] | null {
  const root = researchState.researchRoot(base);
  if (!fs.existsSync(root)) return [];
  try {
    // Only directories WITH state.json are campaigns. Service dirs (.auto/research/briefs,
    // .auto/research/evidence) are not campaigns; state creation follows mkdir atomically.
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => fs.existsSync(path.join(root, d.name, researchState.STATE_FILE)))
      .map((d) => d.name)
      .sort();
  } catch {
    return null;
  }
}

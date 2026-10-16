/** Reads the Work Model fields from a Project Home README's frontmatter. */
export function readmeFrontmatter(readme: string): {
  id?: string;
  area?: string;
  goal?: string;
  area_repo?: string;
  scope?: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readme);
  if (!match) return {};
  const result: { id?: string; area?: string; goal?: string; area_repo?: string; scope?: string } =
    {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(id|area|goal|area_repo|scope):\s*(.*)$/.exec(line);
    if (!field) continue;
    const value = field[2]!
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (value) result[field[1] as keyof typeof result] = value;
  }
  return result;
}

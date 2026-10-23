import type { AuditEntry, Run } from "../../../shared/contracts";

export function knownTime(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 && Number.isFinite(new Date(value).getTime())
    ? value
    : null;
}

export function metadataText(metadata: unknown, key: string): string | undefined {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type ActivityRow =
  | { kind: "run"; id: string; at: number | null; run: Run; error: string | undefined; roomId: string | undefined }
  | { kind: "audit"; id: string; at: number | null; entry: AuditEntry; error: string | undefined; roomId: string | undefined };

/** Only a persisted run ID proves that an audit event describes the same task. */
export function activityRows(runs: readonly Run[], activity: readonly AuditEntry[]): ActivityRow[] {
  const runIds = new Set(runs.map((run) => run.id));
  const represented = (entry: AuditEntry) => entry.action.startsWith("run.") &&
    runIds.has(metadataText(entry.payload, "runId") ?? "");
  return [
    ...runs.map((run): ActivityRow => ({
      kind: "run", id: `run-${run.id}`, run,
      at: knownTime(run.endedAt) ?? knownTime(run.startedAt),
      error: run.error ?? metadataText(activity.find((entry) => represented(entry) &&
        metadataText(entry.payload, "runId") === run.id && metadataText(entry.payload, "error"))?.payload, "error"),
      roomId: metadataText(run.origin, "roomId") ?? metadataText(activity.find((entry) => represented(entry) &&
        metadataText(entry.payload, "runId") === run.id && metadataText(entry.payload, "roomId"))?.payload, "roomId"),
    })),
    ...activity.filter((entry) => !represented(entry)).map((entry): ActivityRow => ({
      kind: "audit", id: `audit-${entry.id}`, entry, at: knownTime(entry.createdAt),
      error: metadataText(entry.payload, "error"),
      roomId: metadataText(entry.payload, "roomId"),
    })),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export interface FileCrumb { readonly path: string; readonly label: string }

/** Breadcrumbs stay below the root returned by the server, never Bot settings. */
export function fileBreadcrumbs(root: string, current: string): FileCrumb[] {
  const base = root.replace(/\/+$/, "") || "/";
  const prefix = base === "/" ? "/" : `${base}/`;
  if (current === base) return [{ path: base, label: base }];
  if (!current.startsWith(prefix)) return [{ path: base, label: base }];
  const parts = current.slice(prefix.length).split("/").filter(Boolean);
  const crumbs: FileCrumb[] = [{ path: base, label: base }];
  for (const part of parts) {
    if (part === ".." || part === ".") return [{ path: base, label: base }];
    const previous = crumbs[crumbs.length - 1]?.path ?? base;
    crumbs.push({ path: `${previous === "/" ? "" : previous}/${part}`, label: part });
  }
  return crumbs;
}

export function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

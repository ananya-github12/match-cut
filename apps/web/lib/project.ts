/**
 * Stub for Cardboard's open project. PRD dependency: "Project defaults (aspect ratio, target
 * length) readable by the frontend". `?aspect=` and `?length=` override them for demos and tests.
 */
export interface Project {
  id: string;
  name: string;
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  lengthSeconds: number | null;
}

export const DEMO_PROJECT: Project = {
  id: "demo-project",
  name: "Spring launch",
  aspect: "9:16",
  lengthSeconds: 30,
};

export function projectFromQuery(params: URLSearchParams): Project {
  const aspect = params.get("aspect");
  const length = params.get("length");
  return {
    ...DEMO_PROJECT,
    ...(aspect && ["9:16", "16:9", "1:1", "4:5"].includes(aspect)
      ? { aspect: aspect as Project["aspect"] }
      : {}),
    ...(length ? { lengthSeconds: length === "match" ? null : Number(length) } : {}),
  };
}

/** Safe localStorage (private windows and blocked storage throw). */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  del(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/** PRD: persist the active brief ID per project, so reloads resume it. */
export const activeBriefKey = (projectId: string) => `matchcut:active:${projectId}`;
/** Edited prompt text, kept with the brief (no edit endpoint in the API contract yet). */
export const editKey = (briefId: string) => `matchcut:edit:${briefId}`;
/** Last request inputs, so Regenerate can prefill after a reload. */
export const inputsKey = (briefId: string) => `matchcut:inputs:${briefId}`;

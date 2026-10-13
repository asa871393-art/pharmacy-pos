import { createDemoRepo } from "./demoRepo.ts";
import type { PharmacyRepo } from "./repo.ts";
import { tauriRepo } from "./tauriRepo.ts";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** SQLite inside the desktop app; an in-memory demo store in a plain browser. */
export const repo: PharmacyRepo = inTauri ? tauriRepo : createDemoRepo();
export { localToday } from "./repo.ts";

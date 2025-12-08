import path from "node:path";
import os from "node:os";

export function expandPath(p: string): string {
  if (!p) return "";
  if (p.startsWith("~")) {
    const home = process.env.HOME || os.homedir();
    return path.join(home, p.slice(1));
  }
  return p;
}

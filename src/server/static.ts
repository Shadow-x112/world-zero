// The viewer's files (plain browser JavaScript, HTML and CSS in src/viewer), read once
// and served from memory. Only plain file names are served: no folders, no tricks.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface ViewerFile {
  name: string;
  type: string;
  body: Buffer;
}

export const VIEWER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "viewer");

export class ViewerFiles {
  private files = new Map<string, ViewerFile>();
  private readonly dir: string;
  /** Outside production, files are re-read on every request so edits show at once. */
  private readonly live: boolean;

  constructor(dir: string = VIEWER_DIR, live = process.env.NODE_ENV !== "production") {
    this.dir = dir;
    this.live = live;
    this.load();
  }

  private load(): void {
    this.files = new Map();
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      const type = TYPES[extname(name)];
      if (!type || !/^[a-z0-9][a-z0-9.-]*$/.test(name)) continue;
      this.files.set(name, { name, type, body: readFileSync(join(this.dir, name)) });
    }
  }

  get(name: string): ViewerFile | undefined {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) return undefined;
    if (this.live) this.load();
    return this.files.get(name);
  }

  get names(): string[] {
    return [...this.files.keys()];
  }
}

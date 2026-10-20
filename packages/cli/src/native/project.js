// Reads a project's wrangler.jsonc or wrangler.json.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";

const CONFIG_FILES = ["wrangler.jsonc", "wrangler.json"];

export async function readProjectConfig(projectDirectory) {
  for (const file of CONFIG_FILES) {
    const path = join(projectDirectory, file);
    let source;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const errors = [];
    const config = parse(source, errors, { allowTrailingComma: true });
    if (errors.length > 0) throw new Error(`Invalid ${path}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}.`);
    if (typeof config?.main !== "string") throw new Error(`${path} needs a "main" entry point.`);
    return { ...config, path, directory: projectDirectory };
  }
  throw new Error(`No wrangler.jsonc or wrangler.json in ${projectDirectory}.`);
}

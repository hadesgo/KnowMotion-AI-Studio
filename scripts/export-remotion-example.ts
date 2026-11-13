import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSampleProject } from "../src/data/demo";
import { buildProjectComposition } from "../src/remotion/schema";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDirectory = path.join(root, "examples/night-sky");
await mkdir(outputDirectory, { recursive: true });
const composition = buildProjectComposition(makeSampleProject());
await writeFile(
  path.join(outputDirectory, "composition.json"),
  JSON.stringify(composition, null, 2),
  "utf8",
);
console.log(
  `Exported ${composition.scenes.length}-scene example to examples/night-sky/composition.json`,
);

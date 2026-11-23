// Usage: npx tsx scripts/make-synthetic-addressbook.ts --out <dir>
import { parseArgs } from "node:util";
import { generateAddressBooks } from "./lib/addressbook";

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) {
  console.error("--out <dir> is required");
  process.exit(2);
}
for (const f of generateAddressBooks(values.out)) console.log(f);

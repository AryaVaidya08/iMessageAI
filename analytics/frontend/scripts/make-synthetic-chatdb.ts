// Usage:
//   npx tsx scripts/make-synthetic-chatdb.ts --size small|100mb|1gb --out <file> [--seed N]
//   npx tsx scripts/make-synthetic-chatdb.ts --append N --out <existing file> [--seed N] [--mutate K]
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { appendMessages, generateChatDb, type Size } from "./lib/chatdb";

const { values } = parseArgs({
  options: {
    size: { type: "string", default: "small" },
    out: { type: "string" },
    seed: { type: "string", default: "42" },
    append: { type: "string" },
    mutate: { type: "string", default: "2" },
  },
});

if (!values.out) {
  console.error("--out <path> is required");
  process.exit(2);
}
mkdirSync(dirname(values.out), { recursive: true });
const seed = Number(values.seed);

if (values.append !== undefined) {
  if (!existsSync(values.out)) {
    console.error(`--append needs an existing db: ${values.out}`);
    process.exit(2);
  }
  const r = appendMessages({
    db: values.out,
    count: Number(values.append),
    seed,
    mutateExisting: Number(values.mutate),
    size: (values.size as Size) ?? "small",
  });
  console.log(`appended ${r.added} messages (edited ${r.edited}, retracted ${r.retracted}) -> ${values.out}`);
} else {
  const size = values.size as Size;
  if (!["small", "100mb", "1gb"].includes(size)) {
    console.error("--size must be small|100mb|1gb");
    process.exit(2);
  }
  let lastLog = 0;
  const r = generateChatDb({
    out: values.out,
    size,
    seed,
    onProgress: (n, bytes) => {
      if (n - lastLog >= 100_000) {
        lastLog = n;
        console.error(`  ${n} messages, ${(bytes / 1048576).toFixed(0)} MB`);
      }
    },
  });
  console.log(`wrote ${r.messages} messages, ${(r.bytes / 1048576).toFixed(1)} MB -> ${values.out}`);
}

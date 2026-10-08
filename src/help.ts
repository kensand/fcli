import { type Uck } from "./types.js";

export function help(ucks: Uck[], fVersion: string): string {
  const lines = ucks.map((u) => `  ${u.name}  ${u.desc}`);
  return `f v${fVersion} — token-efficient CLI

usage: f <uck> [args]

ucks:
${lines.join("\n")}

run 'f <uck> --help' for details.`;
}

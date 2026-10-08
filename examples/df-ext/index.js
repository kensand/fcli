import { execSync } from "node:child_process";

export function register(ctx) {
  // ctx.ucks — all registered ucks so far (builtins + prior extensions)
  const hasWhich = ctx.ucks.some((u) => u.name === "w");

  return {
    name: "df",
    desc: hasWhich
      ? `disk free (terse) [sees 'w' uck]`
      : "disk free (terse)",
    run: (_argv, args) => {
      const argStr = (args._ ?? []).join(" ");
      try {
        const out = execSync(`df -h ${argStr}`, {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (out) process.stdout.write(out.trimEnd() + "\n");
      } catch (e) {
        if (e.stderr) process.stderr.write(e.stderr);
        process.exit(1);
      }
    },
  };
}

export default { register };

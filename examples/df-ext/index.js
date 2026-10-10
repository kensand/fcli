import { execSync } from "node:child_process";

// register(ctx) runs at LOAD time: ctx only has { fVersion, self }.
// The full uck list (ctx.ucks) and cross-uck registry (ctx.registry) are only
// available at RUN time, as the 3rd arg to run(). A uck can't read other ucks
// during register() — so any "do I see uck X?" logic belongs in run(), not here.
export function register(_ctx) {
  return {
    name: "df",
    desc: "disk free (terse)",
    run: (_argv, args, _ctx) => {
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

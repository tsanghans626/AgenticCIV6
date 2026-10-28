/**
 * Minimal module hook: lets Node run the TypeScript pipeline directly
 * (`node --import ./scripts/ts-loader.mjs src/cli.ts`) without tsx/esbuild.
 *
 * TypeScript sources here import `./foo.js` (the convention tsc/tsx expect).
 * When the imported `.js` does not exist but a sibling `.ts` does, point at the
 * `.ts` instead. Node's built-in type stripping then handles the rest.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      const jsUrl = new URL(specifier, context.parentURL);
      const tsUrl = new URL(jsUrl.href.replace(/\.js$/, ".ts"));
      if (!existsSync(fileURLToPath(jsUrl)) && existsSync(fileURLToPath(tsUrl))) {
        return { url: tsUrl.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

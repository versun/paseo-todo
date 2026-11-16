// Lets Node's native TypeScript support load the plugin sources, which use
// extensionless relative imports (resolved by the bundler in production).
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});

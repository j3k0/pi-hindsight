/**
 * Test-only shim. pi-test-harness imports `getModel` from pi-ai, which no
 * longer exists as a free function in 1.5.2 (it became a Models method). The
 * harness only needs a model that passes session validation — the playbook
 * replaces streamFn before any real streaming. Alias `@earendil-works/pi-ai`
 * here (vitest.config.ts) and re-export the real module unchanged.
 */
import * as actual from "../node_modules/@earendil-works/pi-ai/dist/index.js";
import { fauxProvider } from "../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";

const faux = fauxProvider();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getModel(_provider?: string, _id?: string): any {
  return faux.models[0];
}
export * from "../node_modules/@earendil-works/pi-ai/dist/index.js";
void actual;

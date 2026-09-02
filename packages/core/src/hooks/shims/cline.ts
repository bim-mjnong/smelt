import { cline } from '../../harness/cline.ts';
import { shimAdapterOf } from '../../harness/profile.ts';
import { isMainModule, runShimMain } from '../shim.ts';
import type { ShimAdapter } from '../shim.ts';

/**
 * Cline shim — EXPERIMENTAL tier. The runnable front door only: every fact about this
 * harness, its hook schema included, lives in its profile
 * (`src/harness/cline.ts`), and `shimFromSchema` turns that schema into the
 * adapter below. The installer wires `node dist/hooks/shims/cline.js` as the
 * harness's hook command; this file is what that runs.
 */
export const adapter: ShimAdapter = shimAdapterOf(cline);

if (isMainModule(import.meta.url)) runShimMain(adapter);

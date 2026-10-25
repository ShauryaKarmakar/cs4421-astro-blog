// The static build has its own source directory (`src-static`) so that the
// SSR-only pages are not compiled into the artifact. Astro reads the content
// collection definitions from `<srcDir>/content.config.ts`, so this file
// re-exports the shared definitions instead of duplicating the schemas.
// The glob loaders inside them resolve against the project root, which is the
// same for both builds, so both render exactly the same blog entries.
export { collections } from '../src/content.config';

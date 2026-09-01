declare module "*.tf" { const content: string; export default content; }
declare module "*.yml" { const content: string; export default content; }
declare module "*.yaml" { const content: string; export default content; }
declare module "*.cfg" { const content: string; export default content; }
declare module "*.ini" { const content: string; export default content; }
declare module "*.env" { const content: string; export default content; }
declare module "*.sh" { const content: string; export default content; }
declare module "*.py" { const content: string; export default content; }
declare module "*.toml" { const content: string; export default content; }
declare module "*.json" { const content: string; export default content; }
declare module "*/Caddyfile" { const content: string; export default content; }
// Extensionless resources reached through the dependency graph: ONCE's red
// sources import these by path, and the compiler follows them.
declare module "*/authorized-keys" { const content: string; export default content; }
declare module "*/deploy" { const content: string; export default content; }
declare module "*/once" { const content: string; export default content; }
// The three JavaScript payloads are data here, not modules: they are rendered
// onto the host and executed there. Declared by name rather than as `*.js`,
// which would tell the compiler every JavaScript import in this package is a
// string.
declare module "*/soak.js" { const content: string; export default content; }
declare module "*/acceptance.js" { const content: string; export default content; }
declare module "*/rehearsal.js" { const content: string; export default content; }

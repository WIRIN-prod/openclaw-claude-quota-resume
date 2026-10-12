// Minimal local declaration so `npm run typecheck` works without installing the full
// `openclaw` package. The real contract is checked against the installed SDK in the docs/README.
declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry(entry: {
    id: string;
    name: string;
    description: string;
    register(api: any): void;
  }): unknown;
}

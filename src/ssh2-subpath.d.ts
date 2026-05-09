// Declare the ssh2/lib/client.js subpath import. ssh2's official @types
// only ships entries for the package main (`'ssh2'`). We import the
// subpath directly to bypass index.js's eager `require('./server.js')`
// (so the bundle and the VSIX don't ship SSH server-side code). This
// shim re-exports ssh2's `Client` class as the default export — which
// matches client.js's runtime shape (`module.exports = Client`).
declare module 'ssh2/lib/client.js' {
  import { Client } from 'ssh2';
  // Runtime: `module.exports = Client` (a class). With esModuleInterop,
  // default-importing yields the class itself.
  const ClientDefault: typeof Client;
  export default ClientDefault;
}

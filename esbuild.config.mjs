import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * Mark `.node` native-binding requires as external so esbuild leaves
 * them as bare `require(...)` calls at runtime. We don't ship the .node
 * file itself — when the extension activates and the require fails,
 * ssh2's `try { require(...native binding...) } catch {}` block catches
 * it and falls back to the pure-JS crypto path. This keeps the VSIX
 * platform-agnostic AND lets us bundle ssh2's JS into dist/extension.js
 * (the alternative would be shipping ssh2 as node_modules, which
 * triggers the marketplace's "suspicious content" scanner because the
 * full ssh2 package contains server-side SSH code).
 */
const externalNativeBindings = {
  name: 'external-native-bindings',
  setup(b) {
    b.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true
    }));
  }
};

/**
 * Replace ssh2's WASM-Poly1305 module with a no-op stub. The original
 * `poly1305.js` is an Emscripten-compiled WASM bundle embedded as a
 * 13KB base64 string — VS Marketplace's content scanner flags long
 * base64 blobs as obfuscated/suspicious payloads.
 *
 * Behaviour: the stub's exported initialiser RESOLVES successfully
 * (so ssh2's per-connection `cryptoInit.then(...)` proceeds) but
 * returns a fake WASM module whose `_malloc` returns 0 and whose
 * `cwrap` returns a function that throws if ever invoked. The cipher
 * registration in ssh2 still happens — the throw only fires if the
 * negotiated cipher actually ENDS UP being chacha20-poly1305 at runtime.
 *
 * To prevent that runtime path, our `connection.ts` passes an
 * `algorithms.cipher` list that excludes chacha20-poly1305@openssh.com.
 * Modern OpenSSH always offers at least one AES cipher, so falling
 * back to aes128-gcm / aes256-gcm / aes128-ctr is universal.
 */
const stubPoly1305 = {
  name: 'stub-poly1305',
  setup(b) {
    // esbuild's onResolve filter matches the IMPORT STRING. ssh2's
    // protocol/crypto.js does `require('./crypto/poly1305.js')`.
    b.onResolve({ filter: /(^|[\\/])poly1305\.js$/ }, (args) => {
      if (!args.importer.includes('ssh2')) return null;
      return { path: args.path, namespace: 'stub-poly1305' };
    });
    b.onLoad({ filter: /.*/, namespace: 'stub-poly1305' }, () => ({
      contents: `module.exports = function () {
  return Promise.resolve({
    _malloc: function () { return 0; },
    cwrap: function () {
      return function () {
        throw new Error('ssh2 chacha20-poly1305 cipher disabled in this build (negotiate a different cipher)');
      };
    }
  });
};`,
      loader: 'js'
    }));
  }
};

const baseOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // ssh2 is now bundled (via the subpath import in connection.ts that
  // bypasses ssh2/lib/index.js's eager Server/keygen requires). This
  // tree-shakes server.js and keygen.js out of the shipped artefact —
  // important because VS Marketplace's content scanner has a heuristic
  // that flags extensions shipping SSH server-side code, and the prior
  // VSIX was rejected for "suspicious content" until we did this.
  // `cpu-features` is an OPTIONAL native binding ssh2 tries to require
  // for hardware crypto; keep it external so esbuild doesn't choke on
  // the conditional `try { require('cpu-features') } catch {}`.
  external: ['vscode', 'cpu-features'],
  plugins: [externalNativeBindings, stubPoly1305],
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

if (watch) {
  const ctx = await context(baseOptions);
  await ctx.watch();
  console.log('[esbuild] watching...');
} else {
  await build(baseOptions);
}

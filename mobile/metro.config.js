const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

/**
 * The mesh protocol is shared with the web app rather than forked.
 *
 * `../src/protocol` (packet codec, MTU framing, flooding router) and
 * `../src/replication/policy` are pure TypeScript with no DOM or Node
 * dependency, and they carry the test suite that proves the routing
 * invariants. Copying them here would mean two codecs drifting apart until a
 * phone and a browser could no longer read each other's packets — which is
 * exactly the interoperability this project is about. So Metro is pointed at
 * the sibling directory instead, and `@core/*` resolves into it.
 *
 * Only the pure modules are imported. Anything touching Dexie, Web Workers or
 * `window` has a native counterpart under `mobile/src/`.
 */
const workspaceRoot = path.resolve(__dirname, '..');
const projectRoot = __dirname;

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.resolve(workspaceRoot, 'src')];

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@core': path.resolve(workspaceRoot, 'src'),
};

// Keep resolution anchored to this project's node_modules. Without it Metro
// walks up to the web app's tree and can serve a second copy of React.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

module.exports = config;

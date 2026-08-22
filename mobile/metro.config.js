const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

/**
 * This project resolves everything inside itself.
 *
 * `@core/*` is the radio-agnostic half of the mesh — the packet codec, MTU
 * framing, the flooding router, the store-and-forward queue, the replication
 * policy, BM25 and the vector helpers. It used to resolve into the sibling web
 * app so a single copy served both builds. That coupling meant this app could
 * not be built, tested or checked out without the other one present, and Metro
 * had to be actively stopped from walking into the web app's `node_modules` and
 * serving a second copy of React from it.
 *
 * The modules now live under `src/core/` and are plain TypeScript with no DOM,
 * no Node and no React Native in them — the same code, owned here. The cost is
 * that the two builds' wire formats can now drift apart; `src/core/protocol`
 * carries the codec tests that make a drift show up as a failure rather than as
 * two phones that cannot read each other.
 */
const config = getDefaultConfig(__dirname);

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@core': path.resolve(__dirname, 'src/core'),
};

config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];

module.exports = config;

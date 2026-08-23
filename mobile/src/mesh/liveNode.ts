import type { MeshNode } from './MeshNode';

/**
 * The running node, held above React so it can outlive the screen showing it.
 *
 * A `MeshNode` used to be created and destroyed by an effect, which is correct
 * for something that only exists while it is on screen and wrong for a radio.
 * Android stops the surface when the Activity is destroyed — swiping the app
 * out of recents does exactly that — React unmounts, the effect cleans up, and
 * the node it stops is the one the foreground service was keeping alive. The
 * notification would sit there claiming a mesh that had already shut down.
 *
 * So ownership moves here. The effect *acquires* a node and releases it on
 * unmount, and whether releasing stops it is a decision about background mode
 * rather than about rendering.
 *
 * Keyed by identity, and that key is load-bearing: acquiring while a node for
 * the same identity already runs returns the same instance instead of building
 * a second one. Two nodes beaconing one id over one radio is a state the mesh
 * cannot recover from, and an Activity recreation — a rotation, a theme change,
 * returning from Settings — is enough to ask for one.
 */

interface Live {
    key: number;
    node: MeshNode;
}

let live: Live | null = null;
let keepAlive = false;

/**
 * Whether releasing a node should leave it running.
 *
 * Set from the user's background-mode preference. Nothing here starts or stops
 * the foreground service — the native side does that with the radio — this only
 * decides whether the JavaScript half goes down with the screen.
 */
export function setKeepAlive(on: boolean): void {
    keepAlive = on;
}

export function isKeptAlive(): boolean {
    return keepAlive;
}

/** The node currently running, if any, whether or not a screen is watching. */
export function current(): MeshNode | null {
    return live?.node ?? null;
}

/**
 * The node for this identity, building one only if there is not one already.
 *
 * `fresh` tells the caller whether it owns the start-up: a reused node is
 * already started, and calling `start` twice would double every interval it
 * runs — beacons, outbox flushes, reliability sampling.
 */
export function acquire(key: number, build: () => MeshNode): { node: MeshNode; fresh: boolean } {
    if (live) {
        if (live.key === key) return { node: live.node, fresh: false };
        // A different identity. The old node has to go before the new one
        // starts, or both advertise over the one radio.
        live.node.stop();
        live = null;
    }
    const node = build();
    live = { key, node };
    return { node, fresh: true };
}

/**
 * Hand the node back when the screen goes away.
 *
 * Stops it unless the user asked for the mesh to keep running, which is the
 * whole distinction this module exists to draw.
 */
export function release(node: MeshNode): void {
    if (!live || live.node !== node) return;
    if (keepAlive) return;
    node.stop();
    live = null;
}

/** Unconditional. The user turning background mode off, or leaving for good. */
export function stopLive(): void {
    live?.node.stop();
    live = null;
}

import { loadIdentity } from '../identity/identity';
import { LocalCatalog } from '../storage/store';
import { BleTransport } from '../transport/BleTransport';

import { MeshNode } from './MeshNode';
import { acquire, current, setKeepAlive } from './liveNode';

/** Persisted, so the preference survives a restart — including one nobody asked for. */
export const BACKGROUND_KEY = 'radio.background';

export type DaemonResult = 'running' | 'already-running' | 'no-identity' | 'disabled';

/**
 * Whether this phone should carry the mesh with the app closed. On by default.
 *
 * It was opt-in first, on the reasoning that a permanent notification and a
 * wakelock are an imposition nobody asked for. The reasoning was wrong for what
 * this app is: a mesh of one node is not a mesh, and a phone that only relays
 * while someone is looking at it is not carrying anything. Every peer that
 * routes through this node loses it the moment the app is closed, which makes
 * the default a decision about *other people's* connectivity, not just this
 * one's. So it is on unless the row says otherwise, and the row only says
 * otherwise if someone turned it off.
 *
 * Unset and `'0'` are therefore different, which is why this is not a boolean
 * cast: a phone that has never been asked gets the default, a phone that said
 * no keeps saying no across restarts.
 */
export async function backgroundWanted(store: { kvGet(k: string): Promise<string | null> }): Promise<boolean> {
    return (await store.kvGet(BACKGROUND_KEY)) !== '0';
}

/**
 * Brings the mesh up with nothing on screen.
 *
 * This is the half that makes the daemon a daemon. A foreground service keeps a
 * *running* process running, which covers the app being closed and does not
 * cover the app being killed — the system reclaiming memory, or an OEM's task
 * killer, or the service being restarted after a crash. In all of those the
 * process comes back empty: no Activity, no React tree, no node.
 *
 * Everything needed to restart is already on disk. The identity is a keypair in
 * SQLite, the preference is a row next to it, and the catalog is the database
 * itself, so a cold process can rebuild the node without a user and without the
 * native side having to remember a node id it would then have to keep in sync.
 * That is why the service can afford to be sticky: a restarted service is not a
 * notification with nothing behind it any more, it is this.
 *
 * Deliberately quiet about the two cases that are not failures. A phone with no
 * identity has never finished onboarding and has nothing to run as; a phone
 * with background mode off wants the mesh to stop when the app does. Neither is
 * an error and neither should raise a notification.
 */
export async function startDaemon(): Promise<DaemonResult> {
    const catalog = await LocalCatalog.open();
    if (!(await backgroundWanted(catalog))) return 'disabled';

    const session = await loadIdentity(catalog);
    if (!session) return 'no-identity';

    // Before acquiring, so a node built here is not stopped by the first screen
    // that mounts and unmounts on top of it.
    setKeepAlive(true);

    const running = current();
    const { node, fresh } = acquire(
        session.identity.id,
        () =>
            new MeshNode(
                session.identity,
                new BleTransport(session.identity.id),
                catalog,
                { publicKey: session.keys.publicKey, sign: session.sign },
            ),
    );
    if (!fresh) return running ? 'already-running' : 'running';

    await node.start();
    node.startReplication();
    // Tells the native module the notification it is showing is real, so the
    // peer count on it tracks the radio. On a cold restart the module is a
    // fresh instance that has never heard of the preference.
    await (node.transport as BleTransport).setBackground(true);
    return 'running';
}

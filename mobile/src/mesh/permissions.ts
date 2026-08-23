import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Asking for the radio, before anything tries to use it.
 *
 * The Bluetooth permissions are runtime permissions, and declaring them in the
 * manifest only earns the right to ask. Nothing here ever asked, which was
 * survivable for exactly as long as the mesh was something the user switched on
 * by hand: the radio refused, `capabilities()` said so, and the Node tab
 * explained it.
 *
 * It stopped being survivable when the foreground service arrived. From Android
 * 14 a service declaring `connectedDevice` must hold one of the Bluetooth
 * permissions *at the moment it calls `startForeground`*, and the system throws
 * `SecurityException` into `onStartCommand` rather than returning a failure.
 * That is a hard crash on the main thread of a sticky service, so the process
 * dies, comes back, and dies again — which is what a first run looked like:
 * onboarding writes the keypair, the node boots, the service goes up, and the
 * app disappears before the first screen after onboarding is drawn.
 *
 * So the ask happens here, once, ahead of the radio.
 */

/**
 * Granted or not, as a single answer.
 *
 * Deliberately not thrown. A refusal is a legitimate way to run this app — the
 * catalog, the composer and everything on disk work without a radio — so the
 * caller gets a boolean and decides, rather than an exception that would take
 * the whole boot down with it.
 */
export async function requestMeshPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;

    const wanted = required();
    if (!wanted.length) return true;

    const result = await PermissionsAndroid.requestMultiple(wanted);

    // POST_NOTIFICATIONS is asked for alongside the rest but is not part of the
    // verdict. It only decides whether the service's notification is visible,
    // and a mesh the user cannot see in the shade is still a working mesh —
    // where a missing BLUETOOTH_CONNECT is the crash this function exists for.
    return wanted
        .filter((p) => p !== PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
        .every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
}

/**
 * What this Android version actually wants.
 *
 * The Bluetooth permissions split in two at API 31. Before it, scanning was
 * gated on location — a BLE scan can infer where someone is, so the platform
 * treated it as one — and asking for `BLUETOOTH_SCAN` there gets a permission
 * the system has never heard of. After it, the three `BLUETOOTH_*` permissions
 * exist and `ACCESS_FINE_LOCATION` is no longer needed, because `neverForLocation`
 * on the scan permission makes the same promise more narrowly.
 */
function required(): Array<(typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS]> {
    const api = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
    const P = PermissionsAndroid.PERMISSIONS;

    const permissions = api >= 31
        ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT]
        : [P.ACCESS_FINE_LOCATION];

    // The notification the foreground service posts. Runtime-gated from API 33;
    // granted at install before that.
    if (api >= 33) permissions.push(P.POST_NOTIFICATIONS);

    return permissions;
}

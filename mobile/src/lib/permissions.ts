import { PermissionsAndroid, Platform } from 'react-native';

export interface PermissionOutcome {
  ok: boolean;
  reason: string;
}

/**
 * Android split the Bluetooth permissions in 12 (API 31).
 *
 * Before that, scanning was treated as a location capability and an app had to
 * hold ACCESS_FINE_LOCATION to see any advertisement at all — denying it made
 * scans return nothing, with no error. From 31 the three BLE actions are named
 * directly, and the manifest's `neverForLocation` flag on BLUETOOTH_SCAN is
 * what lets this app skip the location grant entirely.
 *
 * Both sets have to be requested because a hackathon room has both vintages of
 * phone in it.
 */
export async function ensureBlePermissions(): Promise<PermissionOutcome> {
  if (Platform.OS !== 'android') {
    return { ok: false, reason: 'The BLE mesh transport is Android-only' };
  }

  const needed =
    Platform.Version >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  // Asked for only when something is actually missing. Two reasons, and the
  // second is not cosmetic: `requestMultiple` needs an Activity, and the
  // background daemon rebuilds a node with no screen anywhere — from there it
  // throws rather than returning a refusal, which would take down a restart
  // that had every permission it needed.
  const held = await Promise.all(needed.map((p) => PermissionsAndroid.check(p)));
  if (held.every(Boolean)) return { ok: true, reason: '' };

  let results: Awaited<ReturnType<typeof PermissionsAndroid.requestMultiple>>;
  try {
    results = await PermissionsAndroid.requestMultiple(needed);
  } catch {
    // No Activity to put a dialog on. Nothing is broken and nothing can be
    // asked; the next launch with a screen is where this gets resolved.
    return { ok: false, reason: 'MeshNet needs the nearby-devices permission — open the app to grant it' };
  }
  const denied = needed.filter((p) => results[p] !== PermissionsAndroid.RESULTS.GRANTED);

  // Asked separately, and its refusal is not fatal. From Android 13 a
  // notification needs consent, and the foreground service keeping the radio
  // alive is required to post one. Refusing it does not stop the service — it
  // removes the only visible sign that a radio is running with the app closed,
  // which is a worse outcome for the user than for the mesh, and not a reason
  // to refuse to start.
  if (Platform.Version >= 33) {
    await PermissionsAndroid.request(
      'android.permission.POST_NOTIFICATIONS' as Parameters<typeof PermissionsAndroid.request>[0],
    ).catch(() => undefined);
  }

  if (!denied.length) return { ok: true, reason: '' };

  const permanently = denied.some(
    (p) => results[p] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
  );
  const names = denied.map((p) => p.split('.').pop()).join(', ');
  return {
    ok: false,
    reason: permanently
      ? `${names} was denied permanently — grant it in Settings > Apps > MeshNet > Permissions`
      : `MeshNet cannot use the radio without ${names}`,
  };
}

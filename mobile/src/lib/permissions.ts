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

  const results = await PermissionsAndroid.requestMultiple(needed);
  const denied = needed.filter((p) => results[p] !== PermissionsAndroid.RESULTS.GRANTED);
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

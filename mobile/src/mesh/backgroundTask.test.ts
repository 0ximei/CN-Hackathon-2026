import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The task key is a contract across two languages and nothing checks it.
 *
 * Kotlin asks React Native to start a task by name; JavaScript registers a
 * handler under that name. Rename either side and the call still compiles,
 * still runs, and fails at the only moment that matters — with the app closed,
 * on someone else's phone, as a node that quietly stopped beaconing. So the
 * two spellings are compared here rather than trusted.
 *
 * Read as text on purpose: importing the module pulls in `react-native`, which
 * does not load off-device, and this is about the literal either way.
 */
const root = join(__dirname, '../..');

function only(pattern: RegExp, file: string): string {
    const source = readFileSync(join(root, file), 'utf8');
    const found = source.match(pattern);
    expect(found, `no task key in ${file}`).toBeTruthy();
    return found![1];
}

describe('background task', () => {
    it('registers the key the native side starts', () => {
        const ts = only(
            /export const BACKGROUND_TASK = '([^']+)'/,
            'src/mesh/backgroundTask.ts',
        );
        const kotlin = only(
            /private const val AWAKE_TASK = "([^"]+)"/,
            'modules/ble-mesh/android/src/main/java/expo/modules/blemesh/MeshService.kt',
        );
        expect(kotlin).toBe(ts);
    });

    /**
     * Registration has to happen in the entry file, not in a screen.
     *
     * The background preference is restored during start-up and turns the task
     * on immediately, so a registration that waited for a component to mount
     * would lose the race on exactly the phones that had background mode on.
     */
    it('registers before the app renders', () => {
        const entry = readFileSync(join(root, 'index.js'), 'utf8');
        const register = entry.indexOf('registerBackgroundTask()');
        const render = entry.indexOf('registerRootComponent(');
        expect(register).toBeGreaterThan(-1);
        expect(render).toBeGreaterThan(-1);
        expect(register).toBeLessThan(render);
    });

    /**
     * The service must outlive the task it was launched from.
     *
     * `stopWithTask` defaults to false, which is the reason it is written down
     * — a default is not a decision, and `expo prebuild` regenerates manifests.
     * Set to true, or dropped in a merge that turns it back into a default
     * nobody is watching, the service dies with the swipe and everything else
     * here is pointless.
     */
    it('keeps the service when the task is swiped away', () => {
        const manifest = readFileSync(
            join(root, 'modules/ble-mesh/android/src/main/AndroidManifest.xml'),
            'utf8',
        );
        const service = manifest.match(/<service[\s\S]*?\/>/);
        expect(service, 'no service declared').toBeTruthy();
        expect(service![0]).toContain('android:stopWithTask="false"');
        // The type that exempts the process from background throttling, and
        // that Android 14 makes mandatory.
        expect(service![0]).toContain('android:foregroundServiceType="connectedDevice"');

        // React Native's HeadlessJsTaskService takes a wakelock as the first
        // thing it does, and throws a SecurityException without this. Missing,
        // background mode does not degrade — it crashes the moment it is
        // switched on, which is not something a build catches.
        expect(manifest).toContain('android.permission.WAKE_LOCK');
    });
});

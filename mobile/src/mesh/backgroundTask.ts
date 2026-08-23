import { AppRegistry, Platform } from 'react-native';

import { startDaemon } from './daemon';

/**
 * The JavaScript half of the background daemon. Two jobs, both load-bearing.
 *
 * **It keeps the clock running.** React Native stops delivering timers when the
 * Activity pauses: `JavaTimerManager.onHostPause` drops the choreographer
 * callback that fires expired timers, and `onHostDestroy` — which is what
 * swiping the app out of recents reaches — leaves it dropped. Most apps never
 * notice. This one is nothing but those timers: beacons, outbox flushes,
 * catalog sync, peer liveness. Without this the app closed to a radio still
 * advertising with nothing answering above it, so peers saw the hardware, got
 * no HELLO, and dropped the node. The one exception React Native makes is a
 * headless task — `clearFrameCallback` leaves the clock alone whenever
 * `hasActiveTasks()` is true — so this task exists to never finish.
 *
 * **And it starts the mesh when nothing else can.** The service is sticky, so
 * a killed process comes back, and it comes back with no Activity and no React
 * tree. This task is then the only thing running, and [`startDaemon`](daemon.ts)
 * rebuilds the node from what is on disk.
 */
export const BACKGROUND_TASK = 'MeshNetBackground';

/**
 * Resolver for the running task, so a restart cannot pile up pending promises.
 *
 * Native finishing a task does not settle the promise on this side — it only
 * stops React Native counting it — so without this a phone toggled in and out
 * of background mode all day would accumulate one dangling promise per toggle.
 */
let previous: (() => void) | null = null;

export function registerBackgroundTask(): void {
    if (Platform.OS !== 'android') return;
    AppRegistry.registerHeadlessTask(BACKGROUND_TASK, () => async () => {
        previous?.();
        try {
            await startDaemon();
        } catch (e) {
            // Nothing above this catches, and an unhandled rejection here would
            // end the task and with it the clock. A node that failed to start
            // is bad; a node that failed to start *and* took the timers of a
            // running one with it is worse.
            console.warn('mesh daemon did not start', e);
        }
        await new Promise<void>((resolve) => {
            previous = resolve;
        });
    });
}

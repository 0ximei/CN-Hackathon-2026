import { registerRootComponent } from 'expo';
import App from './App';
import { registerBackgroundTask } from './src/mesh/backgroundTask';

// Before the root component, because the native side may ask for the task the
// moment the module comes up — a phone that had background mode on yesterday
// turns it back on during startup, without waiting for a screen.
registerBackgroundTask();

registerRootComponent(App);

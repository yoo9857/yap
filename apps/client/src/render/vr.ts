import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import type { FrameScheduler } from "../app/loop.js";

/**
 * WebXR session plumbing, shared by any mode that wants a headset.
 *
 * Deliberately thin: three's own `VRButton` handles the permission dance and
 * the session lifecycle (it is the upstream-maintained path and tracks browser
 * quirks we should not re-litigate), we only restyle it to the crayon brand and
 * translate its session events into two callbacks.
 */

/** Is an immersive VR headset actually available right now? */
export async function vrSupported(): Promise<boolean> {
  const xr = navigator.xr;
  if (!xr) return false;
  try {
    return await xr.isSessionSupported("immersive-vr");
  } catch {
    // some browsers reject on a policy-blocked feature rather than resolving
    return false;
  }
}

/**
 * Frame source for an active XR session. Inside a session rAF still fires, but
 * only `setAnimationLoop` frames carry an `XRFrame` with the current head pose,
 * so rendering from anywhere else shows a stale (juddering) view.
 */
export function xrScheduler(renderer: THREE.WebGLRenderer): FrameScheduler {
  return {
    start(frame) {
      renderer.setAnimationLoop((nowMs) => frame(nowMs));
    },
    stop() {
      renderer.setAnimationLoop(null);
    },
  };
}

export interface VrButtonHooks {
  onSessionStart(): void;
  onSessionEnd(): void;
}

/**
 * Enable XR on the renderer and mount an "Enter VR" button. Returns a teardown
 * that removes the button and the listeners.
 */
export function mountVrButton(
  gameRenderer: { renderer: THREE.WebGLRenderer; enableXr(): void },
  hooks: VrButtonHooks,
): () => void {
  gameRenderer.enableXr();
  const renderer = gameRenderer.renderer;
  const button = VRButton.createButton(renderer);
  styleVrButton(button);
  document.body.appendChild(button);

  const onStart = (): void => hooks.onSessionStart();
  const onEnd = (): void => hooks.onSessionEnd();
  renderer.xr.addEventListener("sessionstart", onStart);
  renderer.xr.addEventListener("sessionend", onEnd);

  return () => {
    renderer.xr.removeEventListener("sessionstart", onStart);
    renderer.xr.removeEventListener("sessionend", onEnd);
    button.remove();
  };
}

/** three's default button is a grey translucent bar; make it a crayon chip. */
function styleVrButton(button: HTMLElement): void {
  const s = button.style;
  s.position = "fixed";
  s.bottom = "18px";
  s.left = "50%";
  s.transform = "translateX(-50%)";
  s.width = "auto";
  s.padding = "10px 22px";
  s.border = "3px solid #1f2933";
  s.borderRadius = "999px";
  s.background = "#f9d71c";
  s.color = "#1f2933";
  s.font = '700 15px/1.1 "Jua", system-ui, sans-serif';
  s.letterSpacing = "0.02em";
  s.opacity = "1";
  s.cursor = "pointer";
  s.zIndex = "40";
  s.boxShadow = "0 3px 0 #1f2933";
}

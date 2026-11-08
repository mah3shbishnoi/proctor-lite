# ProctorLite

A local, mock proctored-assessment page for testing your browser, camera, microphone, fullscreen and network before a real interview. Plain HTML, CSS and JS. There is no backend, no CDN and no data leaves your machine. The only request the page makes is `GET ping.txt` on its own origin.

## Run

```bash
python3 -m http.server 8000
# open http://localhost:8000 in Chrome/Chromium or Firefox
```

Files: `index.html`, `style.css`, `app.js`, `ping.txt`.

## Flow

1. **System check**. Browser, camera, mic (speak past the marker), network (10 pings, re-measured every 5s), fullscreen, and optional screen share. **Start Test** unlocks when all required checks pass.
2. **Test**. Runs for 10 minutes (`CONFIG.TEST_MINUTES`). Detections run until you submit or time runs out.
3. **Report**. Shows the summary and the event log. You can download it as JSON or restart.

## Blocking modals

- **Left fullscreen**: appears immediately, with a *Return to fullscreen* button. The time taken to return is logged.
- **Left the test window**: appears when you come back after a tab switch or window blur. It reads "You left the test window for X seconds. This has been recorded." and has an *I understand* button. One away episode counts as one violation, however many blur and visibility events it produces.
- **Camera or mic lost**: appears when a track ends or is muted. It stays until every device works again. It closes by itself if the device unmutes. *Retry devices* re-acquires a camera or mic whose track ended. Plugging a device back in (`devicechange`) also triggers a retry.

## How to test each detection

| Detection | How |
|---|---|
| Fullscreen exit | Press **Esc** or F11 and the modal appears. |
| Tab switch / blur | Switch tabs or click another window. Come back to see the away modal. |
| Alt+Tab | Press it. It is logged as a violation only if a blur follows. |
| Camera ended | Unplug the USB camera. The device modal appears. Re-plug it and it recovers. |
| Camera muted | Close the hardware privacy shutter or use the OS camera kill switch, where it mutes the track. |
| Camera stalled | Freeze the stream (for example `kill -STOP` the browser's video-capture process). It counts after 3s without frames. |
| Mic ended or muted | Unplug the mic or use the OS mic mute. Prolonged silence (60s) is info only. |
| Device change | Plug or unplug any audio or video device. |
| Screen share stopped | Enable the share in the check screen, then click "Stop sharing" during the test. |
| Window resize or screen count | Resize while fullscreen is kept (tiling WM), or plug in or unplug a monitor. |
| Copy / cut / paste, right-click, selection | Try them in the editor and on the question text. |
| Shortcuts | Ctrl+C/V/X/P/S/U, F12, Ctrl+Shift+I/J/C and PrintScreen. |
| Lag spike | DevTools → Network → throttle to "Offline" or add latency. A ping above 500ms, or a failed ping, counts. |
| Offline / online | DevTools offline toggle, or disable Wi-Fi. A banner appears. |
| beforeunload | Press F5 or Ctrl+W mid-test. The browser asks for confirmation. |
| Flag banner | Reach 5 violations. A red banner appears but the test is not ended. |
| Face detection | Set `CONFIG.FACE_DETECTION = true` in `app.js`, or tick the box on the check screen. It needs `window.FaceDetector`. |

## Design choices

- Every violation, including the lag spike and the shortcuts, increments the counter. Esc, Alt+Tab (until a blur follows), device restore events and prolonged silence are info only.
- Tab switch and window blur are merged into one "Left test window" violation, recorded when you return.
- The screen count comes from `getScreenDetails()` only if you clicked Browser **Re-check** (it prompts for permission). Otherwise it falls back to `screen.isExtended`.
- Camera and mic are requested separately, so Firefox may show two permission prompts.
- Cleanup on test end: tracks stopped, intervals cleared, listeners removed, the AudioContext closed and fullscreen exited.

## Self-review: detections that are not reliable

- **Esc keydown**: browsers consume Esc to leave fullscreen and never deliver the key event. The `fullscreenchange` event is the real detection.
- **Alt+Tab, Super, workspace switching (Wayland and tiling WMs)**: the compositor handles these keys, so the page never sees them. Only `blur` is seen. Chromium cannot track occlusion on Wayland. A window moved to another workspace may fire neither `visibilitychange` nor `blur`, so tab-switch detection is best effort.
- **PrintScreen**: the desktop environment or compositor usually grabs it (Spectacle, gnome-screenshot, grim). The page often sees nothing and can never block it.
- **Ctrl+Shift+I, F12, Ctrl+Shift+J/C**: `preventDefault` works in some builds, but Firefox and Chromium reserve some of these. Treat the log as best effort. Screenshots and screen recording from outside the browser are undetectable.
- **Screen count**: `getScreenDetails` is Chromium only and needs permission. Firefox has no equivalent, so screen-count detection does nothing there.
- **Screen share and `displaySurface`**: on Wayland the xdg-desktop-portal and PipeWire chooser decides what is shared. Chromium reports `monitor`, `window` or `browser`. Firefox may report nothing, which shows as "unknown". It needs `xdg-desktop-portal-*` installed.
- **FaceDetector**: Chromium only, behind the experimental flag, and mostly missing on Linux. Firefox has none. The page shows "Face detection unavailable in this browser".
- **Camera stall**: needs `requestVideoFrameCallback` (Chromium, and Firefox 132 and later). Otherwise it falls back to a `currentTime` check. Hidden tabs are skipped because browsers throttle them.
- **Camera and mic mute**: unplugging usually fires `ended`. Hardware shutters and OS kill switches mute the track only on some drivers. Firefox rarely fires `mute` events.
- **Copy, paste and right-click blocking**: these only affect the page. System clipboard managers and X11 middle-click paste may still insert text. Chromium still fires `paste` for those.
- **`navigator.connection`**: Chromium only. Firefox shows "Not supported in this browser".
- **beforeunload**: browsers show the prompt only after a user interaction. The prompt text cannot be customised.
- **AudioContext**: it can start suspended until a click. The page resumes it on the first gesture, so the mic meter may stay flat until you click once.


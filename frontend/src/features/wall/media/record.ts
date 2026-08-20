/**
 * «Записать голосом» — **not built, on purpose.** This file is the finding.
 *
 * §D7.14.11 named this the one open question that decides whether audio ships
 * at all, and gave the instruction for either outcome:
 *
 * > **If it fails**, audio does not degrade to "pick a file", because there is
 * > no file picker for audio on iOS. It degrades to **not shipping audio**. In
 * > that case ship photo and video, say so plainly, and do not leave a record
 * > button that works on Android and not on the iPhones.
 *
 * ## What was established, and how
 *
 * The experiment the design asked for is a physical iPhone with Web Inspector
 * over USB, which nobody building this had. What replaced it is the method
 * `docs/research/ios-pwa-push.md` uses: read Bugzilla and WebKit `main`.
 *
 * **`getUserMedia` in a standalone Home Screen app: works.** Bug **185448** is
 * RESOLVED FIXED and has stayed fixed — landed in iOS 13 beta 1, pulled in beta
 * 2 for an unrelated defect, re-landed in 13.4. The design had this right.
 *
 * **`MediaRecorder` in a standalone Home Screen app: broken today.** Bug
 * **300342** — *"Media Recording fails for websites when added to home
 * screen"* — filed 2025-10-07, **status NEW, Severity Critical, Priority P1**,
 * against Safari 26 / iOS 26, unassigned and with no engineer response. The
 * reproduction is literally MDN's web-dictaphone demo (`getUserMedia` audio
 * plus `MediaRecorder`) added to the Home Screen; the track ends immediately
 * with *"A MediaStreamTrack ended due to a capture failure"*. The reporter's
 * note is the part that makes this unshippable rather than merely buggy:
 *
 * > removing the installed app, and re-adding it will temporarily fix the
 * > issue. The issue will happen again when a user force quits the app and
 * > opens it again.
 *
 * A recorder that works until the first force-quit is worse than no recorder:
 * the family member who used it once will keep reaching for it, and the failure
 * has no explanation anybody in this house could act on.
 *
 * Two neighbours corroborate that this area is actively unwell rather than
 * settled: **299948** (getUserMedia audio yields an ended track on iOS 26) and
 * **273938** (camera stream does not work in a PWA on some devices, NEW since
 * 2024). And **215884** — the non-persistent microphone grant the design
 * already designed around — was touched as recently as February 2026.
 *
 * ## The decision
 *
 * **No record button ships.** The composer offers photo and video, and that is
 * the whole of what «добавить вложение» does on this wall today.
 *
 * What *is* built, because it costs nothing and is not a promise to anybody:
 *
 * - the **playback** side of audio (`MediaRow` in `MediaBlock.tsx`) — the
 *   backend accepts `audio/mp4` and `audio/mpeg` and can therefore hold an
 *   audio row, and a card that cannot draw one would be a broken card rather
 *   than an absent feature;
 * - `audio/mp4,audio/mpeg` in the picker's `accept` (see `limits.ts`), which is
 *   a correction to §D7.14.3 rather than a new door: the WebKit branch that
 *   breaks audio picking tests the **wildcard string**, so the explicit types
 *   do not take it.
 *
 * ## What would reopen this
 *
 * Bug 300342 closing, plus the ten-minute device test the design specified,
 * which is still the only thing that can actually settle it: on the installed
 * PWA, force-quit, reopen, tap record, confirm the prompt appears, confirm a
 * blob comes back, and read its `mimeType`. If it passes, this file becomes the
 * recorder the design describes — `MediaRecorder.isTypeSupported()` with an
 * `audio/mp4` fallback, an explain-then-prompt flow, and the assumption that
 * the grant is never remembered across launches.
 *
 * Verified against WebKit `main` and bugs.webkit.org on **2026-08-21**.
 * Re-verify before trusting any of it in a year.
 */

/**
 * Whether the app offers to record a voice note. Constant `false`, and it is a
 * constant so that the one call site reads as a decision rather than as a
 * missing feature somebody forgot to wire up.
 */
export const VOICE_RECORDING_AVAILABLE = false;

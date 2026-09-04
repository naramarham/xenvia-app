# Building Xenvia for Android

This gets you from this source project to an APK you can install on your
phone. It needs to be run on **your machine** (with network access and,
for the native build step, Android Studio) — none of this could be executed
inside the sandboxed environment this project was built in.

## What you need installed first

- **Node.js 18+** (you likely already have this)
- **Android Studio** (free, from developer.android.com) — this gives you
  the Android SDK, an emulator if you want one, and the Gradle build tools
  Capacitor needs. Install it and let it finish its first-run SDK setup
  before continuing.

## 1. Install dependencies and build the web app

```bash
cd xenvia-app
npm install
npm run build          # produces dist/ — a static, production web build
```

If `npm run build` succeeds, you now have a real working website in
`dist/`. Worth sanity-checking with `npm run preview` and opening it in a
browser before moving on to the native wrapper — easier to debug a plain
web bug in a browser than inside an Android build.

## 2. Add the Android platform

```bash
npx cap add android
```

This is the step that generates the `android/` folder (a real native
Android Studio project) — Capacitor downloads and scaffolds it, which needs
network access and wasn't something that could be pre-generated for you.

## 3. Copy the web build into the native project

```bash
npx cap sync android
```

Run this again any time you change the web app and want the Android
project to pick up the new `dist/` build.

## 4. Open it in Android Studio and build

```bash
npx cap open android
```

Android Studio opens with the generated project. From there:

- **Quick test on a device/emulator**: click the green ▶ Run button.
- **Get an installable APK file**: Build menu → Build Bundle(s)/APK(s) →
  Build APK(s). Android Studio will tell you where the `.apk` landed
  (usually `android/app/build/outputs/apk/debug/app-debug.apk`).

That debug APK is enough to sideload onto your own phone — see step 5.

## 5. Installing it on your phone (sideloading)

1. Copy `app-debug.apk` to your phone (USB cable, email it to yourself,
   Google Drive, whatever's easiest).
2. On the phone: Settings → Security (or "Apps") → allow installs from the
   source you're using (this wording varies by Android version/manufacturer).
3. Open the APK file on the phone and install it.

This is completely normal for testing your own app — you don't need Google
Play for this step.

## 6. If you want it on the Play Store eventually

That's a different, larger process: you need a **release build** (signed
with your own keystore, not the debug one), an **AAB** (Android App Bundle)
rather than a raw APK, and a Google Play Console developer account
(one-time $25 fee). Android Studio's Build → Generate Signed Bundle/APK
wizard walks through the signing part. Worth doing once you're happy with
the app, not before.

## Switching from sample data to your live backend

By default this app ships with the same bundled sample dataset as the
Claude-artifact version — it works standalone, no backend required. Once
you've deployed the backend (see `xenvia-backend/DEPLOY.md`) and it's
reachable over HTTPS, see the instructions at the bottom of
`src/lib/api.js` for wiring the app up to live data instead.

## Known gaps, stated plainly

- **No app icon/splash screen customization yet** — Capacitor ships
  placeholder defaults. `npx cap` has icon/splash generation tooling
  (`@capacitor/assets`) worth adding once you have real branding assets.
- **This hasn't been run end-to-end** — every piece here (the Vite config,
  the Tailwind setup, the storage shim, the Capacitor config) was written
  correctly and syntax-checked, but the actual `npm install` → `cap add
  android` → Gradle build chain needs real network access and Android
  Studio, neither of which was available in the sandbox this was built in.
  If something in this chain errors out, it's most likely a dependency
  version mismatch (Capacitor/Vite/React versions drift over time) rather
  than a structural problem — bumping the relevant package in
  `package.json` is the usual fix.

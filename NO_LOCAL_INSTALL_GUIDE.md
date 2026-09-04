# Building Xenvia with zero local installs

Everything below works from a plain office laptop with locked-down admin
rights — no Node.js, no Android Studio, no git command line, nothing
installed. All you need is a web browser and a free GitHub account.

## The idea

GitHub will run the entire build — `npm install`, the web build, and the
full Android/Gradle build — on *their* servers, for free, every time you
ask it to. You just upload files and click buttons in a browser; GitHub
hands you back a finished APK to download.

## 1. Create a free GitHub account (if you don't have one)

[github.com](https://github.com) → Sign up. Takes two minutes, nothing to
install.

## 2. Create a new repository

- Click the **+** in the top right → **New repository**
- Name it something like `xenvia-app`
- Keep it **Public** (Public repos get unlimited free GitHub Actions
  minutes; Private repos get a smaller free monthly quota, which is still
  fine for occasional builds — Public is just the simplest default if the
  code isn't sensitive)
- Click **Create repository**

## 3. Upload this project's files — no git required

On the new repo's page: **Add file → Upload files**. Drag in everything
from the `xenvia-app` folder (including the hidden `.github` folder — on
Windows you may need to show hidden files first, or just drag the whole
extracted folder contents at once, which usually picks up dotfiles too).
Commit the upload.

If the browser upload silently skips the `.github/workflows/build-android.yml`
file (some browsers are fussy about folders starting with a dot), add it
manually instead: **Add file → Create new file**, name it exactly
`.github/workflows/build-android.yml` (GitHub auto-creates the folders from
the slashes in the name), and paste in the contents of that file from the
zip.

## 4. Run the build

- Go to the **Actions** tab on your repo
- You should see the **Build Android APK** workflow listed — click it
- Click **Run workflow** (the dropdown button) → **Run workflow** again to
  confirm
- Wait a few minutes — you'll see it progress through the steps live
  (installing Node, building the web app, building the APK)

## 5. Download your APK

Once it finishes with a green checkmark, click into that run → scroll down
to **Artifacts** → download `xenvia-debug-apk`. It's a `.zip` containing
`app-debug.apk` — unzip it.

## 6. Get it onto your phone

Transfer `app-debug.apk` to your phone however's easiest (Google Drive,
email to yourself, USB cable) and open it there. Your phone will ask you to
allow installing from that source — that's normal for a debug build not
from the Play Store.

## What about the backend?

Same story — Railway and Render (see `xenvia-backend/DEPLOY.md`) both
deploy straight from a GitHub repo through their website, no local install
needed either. Same pattern: upload the `xenvia-backend` folder to its own
GitHub repo, then connect that repo on Railway or Render's site.

## If a step fails

Click into the failed run in the Actions tab — it shows you exactly which
step broke and the full error output, same as it would on a local terminal.
Paste that error back to me and I can help you debug it from there, even
though I can't run the workflow myself to reproduce it directly.

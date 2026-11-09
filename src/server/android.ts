/** Android export: wraps the web build in a small WebView app and builds a signed APK with the Android SDK tools (no Gradle, no network). */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Bitmap } from '../core/sprite.js';
import type { Problem } from '../core/game/catalog.js';
import { ANDROID_PACKAGE_RE, type GameProject, androidPackage, gameSlug } from '../core/game/types.js';
import { buildAsset, buildGameHtml, loadGameBundle, loadRuntime } from './game.js';
import { encodePng } from './png.js';
import type { Workspace } from './store.js';

const execFileAsync = promisify(execFile);
const MIN_SDK = 24;
const EXE = process.platform === 'win32' ? '.exe' : '';

export interface AndroidTools {
  aapt: string;
  aapt2: string;
  zipalign: string;
  d8Jar: string;
  apksignerJar: string;
  androidJar: string;
  apiLevel: number;
  java: string;
  javac: string;
  keytool: string;
}

const newestFirst = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

function findJdkTool(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = [
    env.JAVA_HOME && path.join(env.JAVA_HOME, 'bin'),
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin',
    ...(env.PATH ?? '').split(path.delimiter),
  ].filter((d): d is string => !!d);
  for (const d of dirs) if (fs.existsSync(path.join(d, name + EXE))) return path.join(d, name + EXE);
  return null;
}

/** Locates the Android SDK and the JDK. The error says what to install when something is missing. */
export function findAndroidTools(env: NodeJS.ProcessEnv = process.env): AndroidTools {
  const home = os.homedir();
  const sdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, path.join(home, 'Library/Android/sdk'), path.join(home, 'Android/Sdk'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk')]
    .filter((d): d is string => !!d)
    .find((d) => fs.existsSync(path.join(d, 'build-tools')) && fs.existsSync(path.join(d, 'platforms')));
  if (!sdk) throw new Error('Android SDK not found. Install Android Studio (it includes the SDK) or set ANDROID_HOME to the SDK folder.');

  const buildTools = fs.readdirSync(path.join(sdk, 'build-tools')).sort(newestFirst).map((v) => path.join(sdk, 'build-tools', v)).find((d) => fs.existsSync(path.join(d, 'lib', 'd8.jar')) && fs.existsSync(path.join(d, 'aapt2' + EXE)));
  if (!buildTools) throw new Error(`No usable build-tools in ${sdk}. Install them from Android Studio: SDK Manager > SDK Tools > Android SDK Build-Tools.`);

  const platform = fs.readdirSync(path.join(sdk, 'platforms')).filter((p) => /^android-\d+$/.test(p) && fs.existsSync(path.join(sdk, 'platforms', p, 'android.jar'))).sort(newestFirst)[0];
  if (!platform) throw new Error(`No Android platform in ${sdk}. Install one from Android Studio: SDK Manager > SDK Platforms.`);

  const [java, javac, keytool] = ['java', 'javac', 'keytool'].map((t) => findJdkTool(t, env));
  if (!java || !javac || !keytool) throw new Error('Java JDK not found. Install JDK 17 or newer, or set JAVA_HOME to it.');

  return {
    aapt: path.join(buildTools, 'aapt' + EXE),
    aapt2: path.join(buildTools, 'aapt2' + EXE),
    zipalign: path.join(buildTools, 'zipalign' + EXE),
    d8Jar: path.join(buildTools, 'lib', 'd8.jar'),
    apksignerJar: path.join(buildTools, 'lib', 'apksigner.jar'),
    androidJar: path.join(sdk, 'platforms', platform, 'android.jar'),
    apiLevel: Number(platform.slice('android-'.length)),
    java,
    javac,
    keytool,
  };
}

async function run(step: string, cmd: string, args: string[], cwd?: string): Promise<void> {
  try {
    await execFileAsync(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error(`Android build failed (${step}): ${(e.stderr || e.stdout || e.message).trim().slice(-1500)}`);
  }
}

const escapeXml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Text for a value of strings.xml: Android gives \ ' " and a leading @ or ? a meaning of their own. */
export function androidString(s: string): string {
  return escapeXml(s.replace(/[\\'"]/g, '\\$&').replace(/^[@?]/, '\\$&'));
}

function manifest(pkg: string, versionCode: number, versionName: string, game: GameProject, apiLevel: number): string {
  const orientation = game.width >= game.height ? 'sensorLandscape' : 'sensorPortrait';
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}" android:versionCode="${versionCode}" android:versionName="${escapeXml(versionName)}">
  <uses-sdk android:minSdkVersion="${MIN_SDK}" android:targetSdkVersion="${apiLevel}"/>
  <application android:label="@string/app_name" android:icon="@mipmap/ic_launcher" android:allowBackup="true" android:hardwareAccelerated="true" android:theme="@android:style/Theme.Black.NoTitleBar.Fullscreen">
    <activity android:name="com.spritifer.player.MainActivity" android:exported="true" android:launchMode="singleTask" android:screenOrientation="${orientation}" android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|navigation|uiMode|density|fontScale|locale|layoutDirection">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
  </application>
</manifest>
`;
}

/** Full-screen WebView playing assets/index.html. file:///android_asset needs no INTERNET permission and keeps localStorage saves. */
const MAIN_ACTIVITY = `package com.spritifer.player;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.DisplayCutout;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

public final class MainActivity extends Activity {
  private static final String HOME = "file:///android_asset/index.html";
  private WebView web;

  @Override protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    if (Build.VERSION.SDK_INT >= 28) {
      // Keeps the on-screen controls clear of the camera notch.
      root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
        @Override public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
          DisplayCutout c = insets.getDisplayCutout();
          if (c != null) v.setPadding(c.getSafeInsetLeft(), c.getSafeInsetTop(), c.getSafeInsetRight(), c.getSafeInsetBottom());
          return insets;
        }
      });
    }

    web = new WebView(this);
    web.setBackgroundColor(Color.BLACK);
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setTextZoom(100);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        return !r.getUrl().toString().startsWith("file:///android_asset/");
      }
      @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
        // Android may kill the page to free memory: start again from the saved game instead of crashing.
        recreate();
        return true;
      }
    });

    root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    setContentView(root);
    hideBars();
    web.requestFocus();
    web.loadUrl(HOME);
  }

  private void hideBars() {
    if (Build.VERSION.SDK_INT >= 30) {
      getWindow().setDecorFitsSystemWindows(false);
      WindowInsetsController c = getWindow().getInsetsController();
      if (c != null) {
        c.hide(WindowInsets.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
    } else {
      getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
  }

  @Override public void onWindowFocusChanged(boolean focused) {
    super.onWindowFocusChanged(focused);
    if (focused) hideBars();
  }

  @Override protected void onPause() {
    super.onPause();
    web.onPause();
  }

  @Override protected void onResume() {
    super.onResume();
    web.onResume();
  }

  @Override protected void onDestroy() {
    web.destroy();
    super.onDestroy();
  }

  /** Back leaves the game running in the background, so a stray press does not lose unsaved progress. */
  @Override public void onBackPressed() {
    moveTaskToBack(true);
  }
}
`;

/** The sprite to use as app icon: the chosen one, one named "icon", else the first object's. */
function iconSource(ws: Workspace, game: GameProject): Bitmap | null {
  const available = new Set(ws.list().map((s) => s.name));
  const name = [game.android?.icon, 'icon', 'app_icon', ...game.objects.map((o) => o.sprite)].find((n) => n && available.has(n));
  if (!name) return null;
  const { asset, sheet } = buildAsset(ws.load(name), false);
  const f = asset.frames[0];
  if (!f) return null;
  // Crop to the visible pixels of the first frame.
  let [x0, y0, x1, y1] = [f.w, f.h, -1, -1];
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      if (sheet.data[((f.y + y) * sheet.width + f.x + x) * 4 + 3] < 128) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return null;
  const out: Bitmap = { width: x1 - x0 + 1, height: y1 - y0 + 1, data: new Uint8ClampedArray((x1 - x0 + 1) * (y1 - y0 + 1) * 4) };
  for (let y = 0; y < out.height; y++) {
    const from = ((f.y + y0 + y) * sheet.width + f.x + x0) * 4;
    out.data.set(sheet.data.subarray(from, from + out.width * 4), y * out.width * 4);
  }
  return out;
}

/** Draws src centered in a size×size square, inside a box×box area; whole-number zoom when it fits, to keep pixels crisp. */
function iconImage(src: Bitmap | null, size: number, box: number, background: [number, number, number] | null): Bitmap {
  const out: Bitmap = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
  if (background) for (let i = 0; i < out.data.length; i += 4) out.data.set([...background, 255], i);
  if (!src) return out;
  const fit = box / Math.max(src.width, src.height);
  const k = fit >= 1 ? Math.floor(fit) : fit;
  const w = Math.round(src.width * k);
  const h = Math.round(src.height * k);
  const left = Math.floor((size - w) / 2);
  const top = Math.floor((size - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / k) * src.width + Math.floor(x / k)) * 4;
      if (src.data[s + 3] < 128) continue;
      const t = ((top + y) * size + left + x) * 4;
      out.data[t] = src.data[s];
      out.data[t + 1] = src.data[s + 1];
      out.data[t + 2] = src.data[s + 2];
      out.data[t + 3] = 255;
    }
  }
  return out;
}

function writeFile(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeResources(dir: string, ws: Workspace, game: GameProject): void {
  const hex = /^#[0-9a-f]{6}/i.exec(game.background)?.[0] ?? '#181425';
  const rgb: [number, number, number] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const src = iconSource(ws, game);
  writeFile(path.join(dir, 'values', 'strings.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources><string name="app_name">${androidString(game.title)}</string><color name="icon_background">${hex}</color></resources>\n`);
  // Android 8+ crops adaptive icons: only the central 66 of 108 units are always visible.
  writeFile(path.join(dir, 'mipmap-anydpi-v26', 'ic_launcher.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/icon_background"/><foreground android:drawable="@drawable/ic_foreground"/></adaptive-icon>\n');
  writeFile(path.join(dir, 'drawable-nodpi', 'ic_foreground.png'), encodePng(iconImage(src, 432, 264, null)));
  writeFile(path.join(dir, 'mipmap-xxxhdpi', 'ic_launcher.png'), encodePng(iconImage(src, 192, 160, rgb)));
}

/** A key of its own for each game, kept out of the game folder so it never reaches a git remote. Updates need the same key. */
async function signingKey(tools: AndroidTools, pkg: string, keysDir: string): Promise<{ keystore: string; passFile: string }> {
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const keystore = path.join(keysDir, `${pkg}.p12`);
  const passFile = path.join(keysDir, `${pkg}.pass`);
  if (fs.existsSync(keystore) && fs.existsSync(passFile)) return { keystore, passFile };
  fs.writeFileSync(passFile, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  try {
    await run('creating the signing key', tools.keytool, ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'game', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Spritifer game', '-storepass:file', passFile]);
  } catch (err) {
    fs.rmSync(keystore, { force: true });
    throw err;
  }
  fs.chmodSync(keystore, 0o600);
  return { keystore, passFile };
}

function filesIn(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

export interface AndroidExportResult {
  file: string;
  bytes: number;
  package: string;
  version: string;
  sprites: number;
  scenes: number;
  keystore: string;
  problems: Problem[];
  warnings: string[];
}

/** Where the APK of this game goes by default. */
export function androidApkPath(ws: Workspace, title: string): string {
  const slug = gameSlug(title);
  return path.join(ws.exportDir, 'android', slug, `${slug}.apk`);
}

/** Builds export/android/<slug>/<slug>.apk: signed, installable, and working offline. */
export async function exportAndroid(ws: Workspace, opts: { outDir?: string; keysDir?: string } = {}): Promise<AndroidExportResult> {
  const tools = findAndroidTools();
  const { bundle, problems } = loadGameBundle(ws, { images: true });
  if (!Object.keys(bundle.scenes).length) throw new Error('The game has no scenes yet: create one first.');
  const game = bundle.game;
  const pkg = androidPackage(game);
  if (!ANDROID_PACKAGE_RE.test(pkg)) throw new Error(`"${pkg}" is not a valid Android package: use at least two parts made of letters, digits or _, each starting with a letter (com.yourname.game).`);
  const version = game.android?.version ?? '1.0';
  // Always grows, so every build can be installed over the previous one (and accepted by the Play Store).
  const versionCode = Math.floor(Date.now() / 60_000);
  const key = await signingKey(tools, pkg, opts.keysDir ?? path.join(os.homedir(), '.spritifer', 'android-keys'));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-android-'));
  try {
    const p = (...parts: string[]) => path.join(work, ...parts);
    writeFile(p('AndroidManifest.xml'), manifest(pkg, versionCode, version, game, tools.apiLevel));
    writeFile(p('assets', 'index.html'), buildGameHtml(bundle, loadRuntime()));
    writeFile(p('src', 'MainActivity.java'), MAIN_ACTIVITY);
    writeResources(p('res'), ws, game);
    fs.mkdirSync(p('classes'));
    fs.mkdirSync(p('dex'));

    await run('compiling resources', tools.aapt2, ['compile', '--dir', p('res'), '-o', p('res.zip')]);
    await run('linking resources', tools.aapt2, ['link', '-o', p('unaligned.apk'), '-I', tools.androidJar, '--manifest', p('AndroidManifest.xml'), '-A', p('assets'), p('res.zip')]);
    await run('compiling the app', tools.javac, ['-nowarn', '-Xlint:none', '-source', '8', '-target', '8', '-bootclasspath', tools.androidJar, '-d', p('classes'), p('src', 'MainActivity.java')]);
    await run('converting to dex', tools.java, ['-cp', tools.d8Jar, 'com.android.tools.r8.D8', '--release', '--min-api', String(MIN_SDK), '--lib', tools.androidJar, '--output', p('dex'), ...filesIn(p('classes'))]);
    await run('packaging', tools.aapt, ['add', p('unaligned.apk'), 'classes.dex'], p('dex'));
    await run('aligning', tools.zipalign, ['-f', '-p', '4', p('unaligned.apk'), p('aligned.apk')]);
    await run('signing', tools.java, ['-jar', tools.apksignerJar, 'sign', '--ks', key.keystore, '--ks-pass', `file:${key.passFile}`, '--out', p('signed.apk'), p('aligned.apk')]);

    const file = opts.outDir ? path.join(path.resolve(opts.outDir), `${gameSlug(game.title)}.apk`) : androidApkPath(ws, game.title);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(p('signed.apk'), file);
    return {
      file,
      bytes: fs.statSync(file).size,
      package: pkg,
      version,
      sprites: Object.keys(bundle.sprites).length,
      scenes: Object.keys(bundle.scenes).length,
      keystore: key.keystore,
      problems,
      warnings: game.touchControls ? [] : ['On-screen controls are off: on a phone the game can only be played by tapping the screen or with a gamepad.'],
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
